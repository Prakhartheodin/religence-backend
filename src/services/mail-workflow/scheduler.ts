import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  MailWorkflowModel,
  type MailWorkflowDocument,
  type MailWorkflowSchedule,
} from '../../models/mail-workflow.model.js';
import {
  MailWorkflowRunModel,
  type MailWorkflowRunDocument,
} from '../../models/mail-workflow-run.model.js';
import { UserModel } from '../../models/user.model.js';
import { listEmailTemplates } from '../email-templates.service.js';
import { sendMessage } from '../outlook.service.js';
import { WorkflowError, type RunStatus } from './contract.js';
import { computeNextRunAt, endDateReached } from './recurrence.js';
import { applyTemplate, leadVars, toHtml } from './render.js';
import { backoffMs, classifySendError, providerIdempotencyKey } from './retry.js';
import {
  inboxPreflight,
  isDuplicateKeyError,
  loadOwnedLeads,
  modelScheduleToContract,
  variablesFromDoc,
} from './workflow.service.js';

const LEASE_MS = 10 * 60 * 1000;
const BATCH_SIZE = 20;
const MAX_SEND_ATTEMPTS = 3;

let ticking = false;

type GateWorkflow = {
  status: MailWorkflowDocument['status'];
  nextRunAt: Date | null;
  runCount: number;
  schedule: MailWorkflowSchedule;
  timezone: string;
};

export function terminalRunStatus(status: RunStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'skipped';
}

export function shouldCompleteBeforeClaim(wf: GateWorkflow, now: Date): boolean {
  if (wf.status !== 'active' || !wf.nextRunAt || wf.nextRunAt > now) return false;
  const schedule = modelScheduleToContract(wf.schedule);
  if (schedule.maxRuns != null && wf.runCount >= schedule.maxRuns) return true;
  return endDateReached(schedule, wf.timezone, wf.nextRunAt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workflowCompleteAfterRun(
  schedule: ReturnType<typeof modelScheduleToContract>,
  timezone: string,
  scheduledAt: Date,
  newRunCount: number,
): boolean {
  if (schedule.maxRuns != null && newRunCount >= schedule.maxRuns) return true;
  const next = computeNextRunAt(schedule, timezone, scheduledAt, { afterOccurrence: scheduledAt });
  return endDateReached(schedule, timezone, next);
}

async function releaseLease(workflowId: string, lockId: string): Promise<boolean> {
  const doc = await MailWorkflowModel.findOneAndUpdate(
    { id: workflowId, lockId },
    { $set: { leaseOwner: null, leaseUntil: null, lockId: null } },
  );
  return doc != null;
}

async function extendLease(workflowId: string, lockId: string, now: Date): Promise<boolean> {
  const doc = await MailWorkflowModel.findOneAndUpdate(
    { id: workflowId, lockId },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
  );
  return doc != null;
}

async function advanceAndRelease(
  wf: MailWorkflowDocument,
  lockId: string,
  scheduledAt: Date,
  now: Date,
  opts: { runCountDelta?: number; failureCountDelta?: number; lastRunAt?: boolean } = {},
): Promise<boolean> {
  const schedule = modelScheduleToContract(wf.schedule);
  const newRunCount = wf.runCount + (opts.runCountDelta ?? 0);
  const complete = workflowCompleteAfterRun(schedule, wf.timezone, scheduledAt, newRunCount);
  const update: Record<string, unknown> = {
    status: complete ? 'completed' : 'active',
    nextRunAt: complete
      ? null
      : computeNextRunAt(schedule, wf.timezone, scheduledAt, { afterOccurrence: scheduledAt }),
    leaseOwner: null,
    leaseUntil: null,
    lockId: null,
  };
  if (opts.runCountDelta) update.runCount = newRunCount;
  if (opts.failureCountDelta) update.failureCount = wf.failureCount + opts.failureCountDelta;
  if (opts.lastRunAt) update.lastRunAt = now;

  const doc = await MailWorkflowModel.findOneAndUpdate({ id: wf.id, lockId }, { $set: update });
  return doc != null;
}

async function claimLease(wf: MailWorkflowDocument, now: Date): Promise<MailWorkflowDocument | null> {
  const lockId = randomUUID();
  const leaseOwner = `${os.hostname()}:${process.pid}`;
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const doc = await MailWorkflowModel.findOneAndUpdate(
    {
      id: wf.id,
      userId: wf.userId,
      status: 'active',
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
    },
    { $set: { leaseOwner, lockId, leaseUntil } },
    { new: true },
  ).lean();
  return doc;
}

async function recordAttempt(runId: string, classified: ReturnType<typeof classifySendError>): Promise<void> {
  await MailWorkflowRunModel.updateOne(
    { id: runId },
    {
      $push: {
        attempts: {
          at: new Date(),
          errorCode: classified.code,
          errorMessage: classified.message,
          retriable: classified.retriable,
        },
      },
      $inc: { attemptCount: 1 },
    },
  );
}

async function failAuthAndPause(
  wf: MailWorkflowDocument,
  lockId: string,
  runId: string,
): Promise<void> {
  await MailWorkflowRunModel.updateOne(
    { id: runId },
    { $set: { status: 'failed', failureReason: 'AUTH_REQUIRED' } },
  );
  await MailWorkflowModel.findOneAndUpdate(
    { id: wf.id, lockId },
    {
      $set: {
        status: 'draft_requires_auth',
        leaseOwner: null,
        leaseUntil: null,
        lockId: null,
      },
    },
  );
}

async function executeOccurrence(wf: MailWorkflowDocument, lockId: string, now: Date): Promise<void> {
  const scheduledAt = wf.nextRunAt;
  if (!scheduledAt) {
    await releaseLease(wf.id, lockId);
    return;
  }

  const idemKey = providerIdempotencyKey(wf.userId, wf.id, scheduledAt);
  let run: MailWorkflowRunDocument;

  try {
    const created = await MailWorkflowRunModel.create({
      id: randomUUID(),
      workflowId: wf.id,
      userId: wf.userId,
      scheduledAt,
      status: 'running',
      attemptCount: 0,
      attempts: [],
      providerIdempotencyKey: idemKey,
    });
    run = created.toObject() as MailWorkflowRunDocument;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await MailWorkflowRunModel.findOne({ workflowId: wf.id, scheduledAt }).lean();
    if (!existing) throw err;
    if (terminalRunStatus(existing.status)) {
      await advanceAndRelease(wf, lockId, scheduledAt, now);
      return;
    }
    run = existing;
  }

  const fresh = await MailWorkflowModel.findOne({ id: wf.id, lockId }).lean();
  if (!fresh || fresh.status !== 'active') {
    await MailWorkflowRunModel.updateOne(
      { id: run.id },
      { $set: { status: 'skipped', skipReason: fresh?.status ?? 'unknown' } },
    );
    await releaseLease(wf.id, lockId);
    return;
  }
  wf = fresh;

  const preflight = await inboxPreflight(wf.userId);
  if (!preflight.sendAllowed || !preflight.accountId) {
    await failAuthAndPause(wf, lockId, run.id);
    return;
  }

  let leads;
  try {
    leads = await loadOwnedLeads(wf.userId, wf.recipientIds);
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'RECIPIENT_NOT_FOUND') {
      await MailWorkflowRunModel.updateOne(
        { id: run.id },
        { $set: { status: 'skipped', skipReason: 'RECIPIENT_NOT_FOUND' } },
      );
      await advanceAndRelease(wf, lockId, scheduledAt, now, { runCountDelta: 1, lastRunAt: true });
      return;
    }
    throw err;
  }

  const templates = await listEmailTemplates(wf.userId);
  const template = templates.find((t) => t.id === wf.templateId);
  if (!template) {
    await MailWorkflowRunModel.updateOne(
      { id: run.id },
      { $set: { status: 'failed', failureReason: 'TEMPLATE_MISSING' } },
    );
    await advanceAndRelease(wf, lockId, scheduledAt, now, {
      runCountDelta: 1,
      failureCountDelta: 1,
      lastRunAt: true,
    });
    return;
  }

  const user = await UserModel.findOne({ userId: wf.userId }).lean();
  const senderName = String(user?.name ?? '').trim() || 'Sender';
  const variables = variablesFromDoc(wf.variables);
  const accountId = wf.accountId || preflight.accountId;

  let sentCount = 0;
  for (const lead of leads) {
    const vars = { ...leadVars(lead, senderName), ...variables };
    const subject = applyTemplate(template.subject, vars);
    const html = toHtml(applyTemplate(template.body, vars));
    const leadIdemKey = `${idemKey}:${lead.id}`;
    let sent = false;

    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await sendMessage(wf.userId, accountId, {
          to: lead.contactEmail,
          subject,
          html,
          idempotencyKey: leadIdemKey,
        });
        sent = true;
        sentCount++;
        break;
      } catch (err) {
        const classified = classifySendError(err);
        await recordAttempt(run.id, classified);
        if (!classified.retriable) {
          if (classified.code === 'AUTH_REQUIRED') {
            await failAuthAndPause(wf, lockId, run.id);
            return;
          }
          break;
        }
        if (attempt < MAX_SEND_ATTEMPTS - 1) {
          if (!(await extendLease(wf.id, lockId, new Date()))) return;
          await sleep(backoffMs(attempt));
        }
      }
    }
  }

  if (sentCount === 0) {
    await MailWorkflowRunModel.updateOne(
      { id: run.id },
      { $set: { status: 'failed', failureReason: 'SEND_FAILED' } },
    );
    await advanceAndRelease(wf, lockId, scheduledAt, now, {
      runCountDelta: 1,
      failureCountDelta: 1,
      lastRunAt: true,
    });
    return;
  }

  await MailWorkflowRunModel.updateOne({ id: run.id }, { $set: { status: 'success' } });
  await advanceAndRelease(wf, lockId, scheduledAt, now, { runCountDelta: 1, lastRunAt: true });
}

export async function runSchedulerTick(now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = await MailWorkflowModel.find({
      status: 'active',
      nextRunAt: { $lte: now },
    }).lean();

    for (const wf of due) {
      if (shouldCompleteBeforeClaim(wf, now)) {
        await MailWorkflowModel.updateOne(
          { id: wf.id, status: 'active' },
          { $set: { status: 'completed', nextRunAt: null } },
        );
      }
    }

    const batch = await MailWorkflowModel.find({
      status: 'active',
      nextRunAt: { $lte: now },
    })
      .limit(BATCH_SIZE)
      .lean();

    for (const wf of batch) {
      const claimed = await claimLease(wf, now);
      if (!claimed?.lockId) continue;
      await executeOccurrence(claimed, claimed.lockId, now);
    }
  } finally {
    ticking = false;
  }
}

if (process.argv[1]?.endsWith('scheduler.ts')) {
  const now = new Date('2026-08-25T04:30:00.000Z');
  const base = {
    status: 'active' as const,
    nextRunAt: new Date('2026-08-25T04:30:00.000Z'),
    runCount: 0,
    timezone: 'Asia/Kolkata',
    schedule: { frequency: 'daily' as const, timeOfDay: '10:00' },
  };

  assert.equal(shouldCompleteBeforeClaim(base, now), false);
  assert.equal(
    shouldCompleteBeforeClaim(
      { ...base, schedule: { ...base.schedule, endDate: '2026-08-24' } },
      now,
    ),
    true,
  );
  assert.equal(
    shouldCompleteBeforeClaim(
      { ...base, schedule: { ...base.schedule, maxRuns: 3 }, runCount: 3 },
      now,
    ),
    true,
  );
  assert.equal(shouldCompleteBeforeClaim({ ...base, status: 'paused' }, now), false);
  assert.equal(
    shouldCompleteBeforeClaim({ ...base, nextRunAt: new Date('2026-08-26T04:30:00.000Z') }, now),
    false,
  );

  assert.equal(terminalRunStatus('success'), true);
  assert.equal(terminalRunStatus('failed'), true);
  assert.equal(terminalRunStatus('skipped'), true);
  assert.equal(terminalRunStatus('running'), false);

  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 11001 }), false);

  console.log('scheduler self-check passed');
}
