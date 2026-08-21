import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  MailWorkflowModel,
  type MailWorkflowDocument,
} from '../../models/mail-workflow.model.js';
import {
  MailWorkflowRunModel,
  type MailWorkflowRunDocument,
  type MailWorkflowRunRecipient,
} from '../../models/mail-workflow-run.model.js';
import { UserModel } from '../../models/user.model.js';
import { listEmailTemplates } from '../email-templates.service.js';
import {
  createWorkflowDraft,
  draftStillExists,
  findSentMessageByInternetId,
  sendWorkflowDraft,
} from '../outlook.service.js';
import {
  WorkflowError,
  type RecipientSendStatus,
  type RunStatus,
  type SendState,
} from './contract.js';
import { mailLog } from './log.js';
import { backoffMs, classifySendError, sendRetryDelayMs } from './retry.js';
import {
  defaultSendGuardLimits,
  evaluateSendGuard,
  loadSendGuardSnapshot,
} from './send-guard.js';
import {
  inboxPreflight,
  loadOwnedLeads,
  renderLeadMessage,
  variablesFromDoc,
  type WorkflowLead,
} from './workflow.service.js';

const EXECUTOR_LEASE_MS = 5 * 60 * 1000;
const MAX_RECIPIENT_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
export const EXECUTOR_BATCH_SIZE = 10;

/** States the executor is still responsible for advancing. */
const OPEN_SEND_STATES: SendState[] = ['scheduled', 'sending', 'provider_accepted'];

function executorId(): string {
  return `${os.hostname()}:${process.pid}`;
}

// ---------------------------------------------------------------------------
// Pure outcome logic (unit-tested below)
// ---------------------------------------------------------------------------

export type RecipientOutcomeCounts = {
  sent: number;
  failed: number;
  unknown: number;
  pending: number;
};

export function countRecipients(recipients: Array<{ status: RecipientSendStatus }>): RecipientOutcomeCounts {
  const counts: RecipientOutcomeCounts = { sent: 0, failed: 0, unknown: 0, pending: 0 };
  for (const r of recipients) {
    if (r.status === 'sent') counts.sent++;
    else if (r.status === 'failed') counts.failed++;
    else if (r.status === 'unknown') counts.unknown++;
    else counts.pending++;
  }
  return counts;
}

/**
 * Never reports plain success unless every recipient was actually accepted by the provider.
 * `unknown` outweighs everything: a human must check the mailbox before we call it done.
 */
export function resolveRunOutcome(counts: RecipientOutcomeCounts): {
  status: RunStatus;
  sendState: SendState;
  needsOperatorReview: boolean;
} {
  if (counts.unknown > 0) {
    return { status: 'unknown', sendState: 'unknown_provider_outcome', needsOperatorReview: true };
  }
  if (counts.sent > 0 && counts.failed === 0) {
    return { status: 'success', sendState: 'succeeded', needsOperatorReview: false };
  }
  if (counts.sent > 0) {
    return { status: 'partial_success', sendState: 'succeeded', needsOperatorReview: false };
  }
  return { status: 'failed', sendState: 'failed', needsOperatorReview: false };
}

/** True when every recipient has reached a terminal state. */
export function runIsSettled(counts: RecipientOutcomeCounts): boolean {
  return counts.pending === 0;
}

// ---------------------------------------------------------------------------
// Provider outcome recovery
// ---------------------------------------------------------------------------

export type ProviderProbe = {
  findSent: (internetMessageId: string) => Promise<{ id: string } | null>;
  draftExists: (messageId: string) => Promise<boolean | null>;
};

export type ProbeResult =
  | { outcome: 'sent'; providerMessageId?: string }
  | { outcome: 'safe_to_resend' }
  | { outcome: 'unknown' };

/**
 * Decide whether a recipient whose dispatch outcome we never observed can be safely
 * retried. This is what keeps a crashed worker from duplicating a delivered email.
 */
export async function probeDispatchedRecipient(
  recipient: Pick<MailWorkflowRunRecipient, 'internetMessageId' | 'providerMessageId'> & {
    internetMessageId?: string | null;
    draftMessageId?: string | null;
  },
  probe: ProviderProbe,
): Promise<ProbeResult> {
  const internetId = recipient.internetMessageId ?? null;
  const draftId = recipient.draftMessageId ?? null;

  if (internetId) {
    const found = await probe.findSent(internetId);
    if (found) return { outcome: 'sent', providerMessageId: found.id };
  }

  if (draftId) {
    const exists = await probe.draftExists(draftId);
    // Draft is still sitting in Drafts → the send never went through → safe to resend it.
    if (exists === true) return { outcome: 'safe_to_resend' };
    // Draft is gone and we could not find it in Sent → most likely sent, possibly deleted.
    if (exists === false && !internetId) return { outcome: 'unknown' };
    if (exists === false) return { outcome: 'unknown' };
  }

  if (!internetId && !draftId) {
    // We never got as far as creating a draft, so nothing can have been delivered.
    return { outcome: 'safe_to_resend' };
  }
  return { outcome: 'unknown' };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function claimRunForExecution(now: Date): Promise<MailWorkflowRunDocument | null> {
  return MailWorkflowRunModel.findOneAndUpdate(
    {
      sendState: { $in: OPEN_SEND_STATES },
      $and: [
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { $or: [{ executorLeaseUntil: null }, { executorLeaseUntil: { $lte: now } }] },
      ],
    },
    {
      $set: {
        executorOwner: executorId(),
        executorLeaseUntil: new Date(now.getTime() + EXECUTOR_LEASE_MS),
        sendState: 'sending',
      },
    },
    { returnDocument: 'after', sort: { nextAttemptAt: 1, createdAt: 1 } },
  ).lean();
}

async function releaseRun(
  runId: string,
  update: Record<string, unknown>,
): Promise<void> {
  await MailWorkflowRunModel.updateOne(
    { id: runId },
    { $set: { ...update, executorOwner: null, executorLeaseUntil: null } },
  );
}

async function persistRecipient(
  runId: string,
  recipientId: string,
  patch: Partial<MailWorkflowRunRecipient>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) set[`recipients.$[r].${k}`] = v;
  await MailWorkflowRunModel.updateOne(
    { id: runId },
    { $set: set },
    { arrayFilters: [{ 'r.recipientId': recipientId }] },
  );
}

async function recordAttempt(
  runId: string,
  recipientId: string,
  classified: ReturnType<typeof classifySendError>,
): Promise<void> {
  await MailWorkflowRunModel.updateOne(
    { id: runId },
    {
      $push: {
        attempts: {
          $each: [{
            at: new Date(),
            recipientId,
            errorCode: classified.code,
            errorMessage: classified.message,
            retriable: classified.retriable,
          }],
          $slice: -100,
        },
      },
      $inc: { attemptCount: 1 },
    },
  );
}

async function markWorkflowAuthPaused(wf: MailWorkflowDocument, runId: string): Promise<void> {
  await MailWorkflowModel.updateOne(
    { id: wf.id, userId: wf.userId },
    { $set: { status: 'paused_auth_required', nextRunAt: null } },
  );
  mailLog.warn('workflow.auth_paused', {
    workspaceId: wf.userId,
    userId: wf.userId,
    workflowId: wf.id,
    runId,
  });
}

/** Attempt one recipient. Returns the new status; never throws for send failures. */
async function attemptRecipient(
  run: MailWorkflowRunDocument,
  wf: MailWorkflowDocument,
  accountId: string,
  recipient: MailWorkflowRunRecipient,
  rendered: { subject: string; html: string },
): Promise<{
  status: RecipientSendStatus;
  authFailed?: boolean;
  retriable?: boolean;
  retryAfterMs?: number;
}> {
  const logCtx = {
    workspaceId: wf.userId,
    userId: wf.userId,
    workflowId: wf.id,
    runId: run.id,
    recipientId: recipient.recipientId,
  };

  // Recipient was already dispatched in a previous (crashed) attempt — resolve, do not resend.
  if (recipient.status === 'sending' || recipient.status === 'unknown' || recipient.dispatchedAt) {
    const probed = await probeDispatchedRecipient(
      {
        internetMessageId: recipient.internetMessageId ?? null,
        draftMessageId: recipient.draftMessageId ?? null,
        providerMessageId: recipient.providerMessageId,
      },
      {
        findSent: (id) => findSentMessageByInternetId(wf.userId, accountId, id),
        draftExists: (id) => draftStillExists(wf.userId, accountId, id),
      },
    );
    if (probed.outcome === 'sent') {
      mailLog.info('send.recovered_as_sent', logCtx);
      await persistRecipient(run.id, recipient.recipientId, {
        status: 'sent',
        acceptedAt: new Date(),
        ...(probed.providerMessageId ? { providerMessageId: probed.providerMessageId } : {}),
      });
      return { status: 'sent' };
    }
    if (probed.outcome === 'unknown') {
      mailLog.warn('send.unknown_provider_outcome', logCtx);
      await persistRecipient(run.id, recipient.recipientId, { status: 'unknown' });
      return { status: 'unknown' };
    }
    mailLog.info('send.safe_to_resend', logCtx);
    // falls through to a fresh dispatch below
  }

  if (recipient.attemptCount >= MAX_RECIPIENT_ATTEMPTS) {
    await persistRecipient(run.id, recipient.recipientId, {
      status: 'failed',
      errorCode: 'MAX_ATTEMPTS',
      errorMessage: `giving up after ${MAX_RECIPIENT_ATTEMPTS} attempts`,
    });
    return { status: 'failed' };
  }

  const correlationId = `${run.providerIdempotencyKey}:${recipient.recipientId}:${recipient.attemptCount}`;

  // --- create draft (nothing has been delivered if this fails) ---
  let draft: { messageId: string; internetMessageId: string | null };
  try {
    draft = await createWorkflowDraft(wf.userId, accountId, {
      to: recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      correlationId,
    });
  } catch (err) {
    const classified = classifySendError(err);
    await recordAttempt(run.id, recipient.recipientId, classified);
    await persistRecipient(run.id, recipient.recipientId, {
      attemptCount: recipient.attemptCount + 1,
      errorCode: classified.code,
      errorMessage: classified.message,
      status: classified.retriable ? 'pending' : 'failed',
    });
    mailLog.warn('send.draft_failed', { ...logCtx, errorCode: classified.code, retriable: classified.retriable });
    if (classified.code === 'AUTH_REQUIRED') return { status: 'pending', authFailed: true };
    const retryAfterMs = sendRetryDelayMs(err, recipient.attemptCount);
    return {
      status: classified.retriable ? 'pending' : 'failed',
      retriable: classified.retriable,
      retryAfterMs: classified.retriable ? retryAfterMs : undefined,
    };
  }

  // --- persist the dispatch evidence BEFORE sending ---
  await persistRecipient(run.id, recipient.recipientId, {
    status: 'sending',
    dispatchedAt: new Date(),
    draftMessageId: draft.messageId,
    internetMessageId: draft.internetMessageId,
    clientRequestId: correlationId,
    attemptCount: recipient.attemptCount + 1,
    // Freeze the rendered subject here — the template may be edited before anyone reads
    // this timeline back.
    subject: rendered.subject,
  });

  // --- send the draft ---
  try {
    await sendWorkflowDraft(wf.userId, accountId, draft.messageId, correlationId);
  } catch (err) {
    const classified = classifySendError(err);
    await recordAttempt(run.id, recipient.recipientId, classified);
    mailLog.warn('send.send_failed', {
      ...logCtx,
      errorCode: classified.code,
      retriable: classified.retriable,
      retryAfterMs: classified.retryAfterMs,
    });
    if (classified.code === 'AUTH_REQUIRED') {
      await persistRecipient(run.id, recipient.recipientId, { status: 'sending' });
      return { status: 'sending', authFailed: true };
    }
    // Leave it in `sending`: the next attempt probes the provider instead of resending blind.
    await persistRecipient(run.id, recipient.recipientId, {
      status: 'sending',
      errorCode: classified.code,
      errorMessage: classified.message,
    });
    const retryAfterMs = sendRetryDelayMs(err, recipient.attemptCount);
    return { status: 'sending', retriable: classified.retriable, retryAfterMs };
  }

  await persistRecipient(run.id, recipient.recipientId, {
    status: 'sent',
    acceptedAt: new Date(),
    providerMessageId: draft.messageId,
  });
  mailLog.info('send.provider_accepted', logCtx);
  return { status: 'sent' };
}

async function finalizeWorkflowAfterRun(wf: MailWorkflowDocument, runId: string): Promise<void> {
  const fresh = await MailWorkflowModel.findOne({ id: wf.id, userId: wf.userId }).lean();
  if (!fresh) return;
  if (fresh.status !== 'active') return;
  if (fresh.nextRunAt) return;
  await MailWorkflowModel.updateOne(
    { id: wf.id, userId: wf.userId, status: 'active', nextRunAt: null },
    { $set: { status: 'completed' } },
  );
  mailLog.info('workflow.completed', {
    workspaceId: wf.userId,
    userId: wf.userId,
    workflowId: wf.id,
    runId,
  });
}

/** Execute one attempt round for a single claimed run. Never sleeps. */
export async function executeRun(run: MailWorkflowRunDocument, now = new Date()): Promise<void> {
  const wf = await MailWorkflowModel.findOne({ id: run.workflowId, userId: run.userId }).lean();
  if (!wf) {
    await releaseRun(run.id, { sendState: 'failed', status: 'failed', failureReason: 'WORKFLOW_MISSING' });
    return;
  }

  const baseCtx = {
    workspaceId: wf.userId,
    userId: wf.userId,
    workflowId: wf.id,
    runId: run.id,
  };

  if (wf.status === 'cancelled' || wf.status === 'paused' || wf.status === 'paused_auth_required') {
    await releaseRun(run.id, { sendState: 'failed', status: 'skipped', skipReason: wf.status });
    mailLog.info('run.skipped_workflow_state', { ...baseCtx, workflowStatus: wf.status });
    return;
  }

  const preflight = await inboxPreflight(wf.userId);
  if (!preflight.sendAllowed || !preflight.accountId) {
    await markWorkflowAuthPaused(wf, run.id);
    await releaseRun(run.id, {
      sendState: 'failed',
      status: 'failed',
      failureReason: 'AUTH_REQUIRED',
      nextAttemptAt: null,
    });
    return;
  }
  // The workflow's stored account may have been disconnected; fall back to the active one.
  const accountId = preflight.accountId;

  let leads: WorkflowLead[];
  try {
    leads = await loadOwnedLeads(wf.userId, wf.recipientIds);
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'RECIPIENT_NOT_FOUND') {
      await releaseRun(run.id, {
        sendState: 'failed',
        status: 'skipped',
        skipReason: 'RECIPIENT_NOT_FOUND',
        nextAttemptAt: null,
      });
      mailLog.warn('run.skipped_recipient_missing', baseCtx);
      await finalizeWorkflowAfterRun(wf, run.id);
      return;
    }
    throw err;
  }

  const templates = await listEmailTemplates(wf.userId);
  // The run stamped its template when the occurrence was created, so editing or deleting
  // the workflow's template cannot retroactively change what this send used. `||` covers
  // every run written before sequences existed — no backfill.
  const runTemplateId = run.templateId || wf.templateId;
  const template = templates.find((t) => t.id === runTemplateId);
  if (!template) {
    await releaseRun(run.id, {
      sendState: 'failed',
      status: 'failed',
      failureReason: 'TEMPLATE_MISSING',
      nextAttemptAt: null,
    });
    mailLog.error('run.template_missing', { ...baseCtx, templateId: runTemplateId });
    await MailWorkflowModel.updateOne({ id: wf.id, userId: wf.userId }, { $inc: { failureCount: 1 } });
    await finalizeWorkflowAfterRun(wf, run.id);
    return;
  }

  const user = await UserModel.findOne({ userId: wf.userId }).lean();
  const senderName = String(user?.name ?? '').trim() || 'Sender';
  const variables = variablesFromDoc(wf.variables);
  const leadById = new Map(leads.map((l) => [l.id, l]));

  let authFailed = false;
  let anyRetriable = false;
  let maxRetryDelayMs = 0;

  const guardLimits = defaultSendGuardLimits();

  for (const recipient of run.recipients) {
    if (recipient.status === 'sent' || recipient.status === 'failed') continue;

    const guardSnap = await loadSendGuardSnapshot(wf.userId, now);
    const guard = evaluateSendGuard(guardSnap, guardLimits);
    if (!guard.allow) {
      const hasOpenRecipients = run.recipients.some(
        (r) => r.status !== 'sent' && r.status !== 'failed',
      );
      await releaseRun(run.id, {
        sendState: hasOpenRecipients ? 'sending' : 'scheduled',
        nextAttemptAt: new Date(now.getTime() + guard.retryAfterMs),
      });
      mailLog.warn('send.guard_deferred', {
        ...baseCtx,
        reason: guard.reason,
        retryAfterMs: guard.retryAfterMs,
        sentLastMinute: guardSnap.sentLastMinute,
        inFlight: guardSnap.inFlight,
        recipientsToday: guardSnap.recipientsToday,
        tenantExternalToday: guardSnap.tenantExternalToday,
        paceCap: guardLimits.pacePerMin,
        inFlightCap: guardLimits.maxInFlight,
        mailboxDailyCap: guardLimits.mailboxRecipientsPerDay,
        tenantDailyCap: guardLimits.tenantExternalPerDay,
      });
      return;
    }

    const lead = leadById.get(recipient.recipientId);
    if (!lead) {
      await persistRecipient(run.id, recipient.recipientId, {
        status: 'failed',
        errorCode: 'RECIPIENT_NOT_FOUND',
        errorMessage: 'lead no longer exists',
      });
      continue;
    }
    if (!recipient.email) {
      await persistRecipient(run.id, recipient.recipientId, {
        status: 'failed',
        errorCode: 'NO_EMAIL',
        errorMessage: 'lead has no contact email',
      });
      continue;
    }

    const rendered = renderLeadMessage(template, lead, senderName, variables);
    const result = await attemptRecipient(run, wf, accountId, recipient, rendered);
    if (result.authFailed) {
      authFailed = true;
      break;
    }
    if (result.retriable) {
      anyRetriable = true;
      if (result.retryAfterMs) maxRetryDelayMs = Math.max(maxRetryDelayMs, result.retryAfterMs);
    }
  }

  if (authFailed) {
    await markWorkflowAuthPaused(wf, run.id);
    await releaseRun(run.id, {
      sendState: 'failed',
      status: 'failed',
      failureReason: 'AUTH_REQUIRED',
      nextAttemptAt: null,
    });
    return;
  }

  const latest = await MailWorkflowRunModel.findOne({ id: run.id }).lean();
  const counts = countRecipients(latest?.recipients ?? []);

  if (!runIsSettled(counts) && anyRetriable && run.attemptCount < MAX_RECIPIENT_ATTEMPTS * 3) {
    // Schedule the retry; do NOT sleep — a later tick picks this run up.
    const delay = maxRetryDelayMs > 0
      ? maxRetryDelayMs
      : backoffMs(Math.min(run.attemptCount, 2));
    await releaseRun(run.id, {
      sendState: 'sending',
      nextAttemptAt: new Date(now.getTime() + delay),
    });
    mailLog.info('run.retry_scheduled', { ...baseCtx, delayMs: delay, retriable: true });
    return;
  }

  // Anything still pending after we stop retrying is a hard failure.
  if (counts.pending > 0) {
    await MailWorkflowRunModel.updateOne(
      { id: run.id },
      { $set: { 'recipients.$[p].status': 'failed' } },
      { arrayFilters: [{ 'p.status': { $in: ['pending', 'sending'] } }] },
    );
  }

  const settled = await MailWorkflowRunModel.findOne({ id: run.id }).lean();
  const finalCounts = countRecipients(settled?.recipients ?? []);
  const outcome = resolveRunOutcome(finalCounts);
  const succeeded = outcome.status === 'success';
  const failedRun = outcome.status === 'failed' || outcome.status === 'partial_success';

  await releaseRun(run.id, {
    status: outcome.status,
    sendState: outcome.sendState,
    needsOperatorReview: outcome.needsOperatorReview,
    nextAttemptAt: null,
    ...(outcome.status === 'failed' ? { failureReason: 'SEND_FAILED' } : {}),
  });

  await MailWorkflowModel.updateOne(
    { id: wf.id, userId: wf.userId },
    {
      $set: {
        lastRunAt: now,
        ...(succeeded ? { failureCount: 0 } : {}),
      },
      $inc: {
        runCount: 1,
        ...(failedRun ? { failureCount: 1 } : {}),
      },
    },
  );

  if (failedRun) {
    const freshWf = await MailWorkflowModel.findOne({ id: wf.id, userId: wf.userId }).lean();
    if (freshWf && freshWf.failureCount >= MAX_CONSECUTIVE_FAILURES && freshWf.status === 'active') {
      await MailWorkflowModel.updateOne(
        { id: wf.id, userId: wf.userId, status: 'active' },
        { $set: { status: 'paused', leaseOwner: null, leaseUntil: null, lockId: null } },
      );
      mailLog.info('workflow.paused_failures', {
        ...baseCtx,
        failureCount: freshWf.failureCount,
      });
    }
  }

  mailLog.info('run.finished', {
    ...baseCtx,
    status: outcome.status,
    sent: finalCounts.sent,
    failed: finalCounts.failed,
    unknown: finalCounts.unknown,
  });

  await finalizeWorkflowAfterRun(wf, run.id);
}

/**
 * One executor pass. Claims up to `EXECUTOR_BATCH_SIZE` runs and advances each by one
 * attempt round. Returns the number of runs touched.
 */
export async function runExecutorPass(now = new Date()): Promise<number> {
  let processed = 0;
  for (let i = 0; i < EXECUTOR_BATCH_SIZE; i++) {
    const run = await claimRunForExecution(now);
    if (!run) break;
    processed++;
    try {
      await executeRun(run, now);
    } catch (err) {
      mailLog.error('run.executor_error', {
        workspaceId: run.userId,
        userId: run.userId,
        workflowId: run.workflowId,
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await releaseRun(run.id, {
        sendState: 'unknown_provider_outcome',
        status: 'unknown',
        needsOperatorReview: true,
        nextAttemptAt: null,
      });
    }
  }
  return processed;
}

export function newRunRecipients(
  leads: Array<{ id: string; contactEmail: string; contactName?: string; companyName?: string }>,
): MailWorkflowRunRecipient[] {
  return leads.map((l) => ({
    recipientId: l.id,
    email: l.contactEmail,
    // Snapshot the person as they were when we scheduled the send — see the model comment.
    contactName: l.contactName ?? '',
    companyName: l.companyName ?? '',
    status: 'pending' as const,
    attemptCount: 0,
    dispatchedAt: null,
    acceptedAt: null,
  }));
}

export function newRunId(): string {
  return randomUUID();
}

if (process.argv[1]?.endsWith('send-executor.ts')) {
  // --- outcome resolution: never claim success when something failed or is unknown ---
  assert.deepEqual(countRecipients([{ status: 'sent' }, { status: 'failed' }]), {
    sent: 1, failed: 1, unknown: 0, pending: 0,
  });
  assert.equal(resolveRunOutcome({ sent: 2, failed: 0, unknown: 0, pending: 0 }).status, 'success');
  assert.equal(resolveRunOutcome({ sent: 1, failed: 1, unknown: 0, pending: 0 }).status, 'partial_success');
  assert.equal(resolveRunOutcome({ sent: 0, failed: 2, unknown: 0, pending: 0 }).status, 'failed');

  const unknown = resolveRunOutcome({ sent: 3, failed: 0, unknown: 1, pending: 0 });
  assert.equal(unknown.status, 'unknown', 'an unknown outcome must not be reported as success');
  assert.equal(unknown.sendState, 'unknown_provider_outcome');
  assert.equal(unknown.needsOperatorReview, true);

  assert.equal(runIsSettled({ sent: 1, failed: 0, unknown: 0, pending: 1 }), false);
  assert.equal(runIsSettled({ sent: 1, failed: 1, unknown: 0, pending: 0 }), true);

  assert.equal(classifySendError({ status: 500 }).retriable, false);
  assert.equal(classifySendError({ status: 504 }).retriable, true);
  assert.equal(sendRetryDelayMs({ status: 429, headers: { 'retry-after': '5' } }, 0), 5_000);

  // --- crash recovery probes ---
  const run = async () => {
    // never dispatched → safe to send
    assert.deepEqual(
      await probeDispatchedRecipient(
        { internetMessageId: null, draftMessageId: null },
        { findSent: async () => null, draftExists: async () => null },
      ),
      { outcome: 'safe_to_resend' },
    );

    // crashed after Graph accepted → found in Sent Items → must NOT resend
    assert.deepEqual(
      await probeDispatchedRecipient(
        { internetMessageId: '<a@b>', draftMessageId: 'd1' },
        { findSent: async () => ({ id: 'sent-1' }), draftExists: async () => true },
      ),
      { outcome: 'sent', providerMessageId: 'sent-1' },
    );

    // crashed before send → draft still in Drafts → safe to resend
    assert.deepEqual(
      await probeDispatchedRecipient(
        { internetMessageId: '<a@b>', draftMessageId: 'd1' },
        { findSent: async () => null, draftExists: async () => true },
      ),
      { outcome: 'safe_to_resend' },
    );

    // draft gone, not found in Sent, Graph unreachable → unknown, never a blind resend
    assert.deepEqual(
      await probeDispatchedRecipient(
        { internetMessageId: '<a@b>', draftMessageId: 'd1' },
        { findSent: async () => null, draftExists: async () => false },
      ),
      { outcome: 'unknown' },
    );
    assert.deepEqual(
      await probeDispatchedRecipient(
        { internetMessageId: '<a@b>', draftMessageId: 'd1' },
        { findSent: async () => null, draftExists: async () => null },
      ),
      { outcome: 'unknown' },
    );

    console.log('send-executor self-check passed');
  };
  void run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
