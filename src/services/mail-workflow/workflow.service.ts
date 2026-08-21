import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../db/mongo.js';
import { CrmEntities } from '../../models/crm-entities.js';
import {
  MailWorkflowModel,
  type MailWorkflowDocument,
  type MailWorkflowSchedule,
} from '../../models/mail-workflow.model.js';
import { MailWorkflowCommandModel } from '../../models/mail-workflow-command.model.js';
import {
  MailWorkflowRunModel,
  type MailWorkflowRunDocument,
} from '../../models/mail-workflow-run.model.js';
import { UserModel } from '../../models/user.model.js';
import { listEmailTemplates, type EmailTemplateRecord } from '../email-templates.service.js';
import { findActiveOutlookAccountsByUser } from '../outlook-store.js';
import { sendMessage } from '../outlook.service.js';
import {
  CONTRACT_VERSION,
  executionModeOf,
  WorkflowError,
  type ExecutionMode,
  type RunStatus,
  type WorkflowAction,
  type WorkflowCommandContractV1,
  type WorkflowSchedule,
  type WorkflowStatus,
} from './contract.js';
import { computeNextRunAt, scheduleRunAt } from './recurrence.js';
import { mailLog } from './log.js';
import { scheduleImmediateWake } from './wake.js';
import {
  applyTemplate,
  extractPlaceholders,
  extraRequiredVars,
  leadVars,
  toHtml,
} from './render.js';
import { classifySendError, providerIdempotencyKey } from './retry.js';

const ISO_DOW = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

const TERMINAL_STATUSES = new Set<WorkflowStatus>(['completed', 'cancelled']);

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

export function workflowTimezone(): string {
  return process.env.WORKFLOW_TIMEZONE?.trim() || 'Asia/Kolkata';
}

function formatTime12(time: string): string {
  const [hStr, mStr] = time.split(':');
  let h = Number(hStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${ampm}`;
}

export function scheduleLabel(s: WorkflowSchedule, tz: string): string {
  if (s.frequency === 'once') {
    return s.runAt ? singleRunLabel(s.runAt, tz) : 'Send once';
  }
  const at = formatTime12(s.time ?? '00:00');
  if (s.frequency === 'daily') return `Every day at ${at}`;
  if (s.frequency === 'weekly') {
    const day = ISO_DOW[(s.dayOfWeek ?? 1) - 1];
    return `Every ${day} at ${at}`;
  }
  const dom = s.dayOfMonth ?? 1;
  const suffix =
    dom % 10 === 1 && dom !== 11 ? 'st'
    : dom % 10 === 2 && dom !== 12 ? 'nd'
    : dom % 10 === 3 && dom !== 13 ? 'rd'
    : 'th';
  return `Every month on the ${dom}${suffix} at ${at}`;
}

function singleRunLabel(sendAtIso: string, timeZone: string): string {
  const dt = new Date(sendAtIso);
  if (Number.isNaN(dt.getTime())) return 'Send once';
  try {
    return `Send once at ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(dt)}`;
  } catch {
    return `Send once at ${dt.toLocaleString()}`;
  }
}

export function endLabel(s: WorkflowSchedule): string {
  if (s.frequency === 'once') return 'Single send';
  if (s.endDate && s.maxRuns) return `Ends ${s.endDate} or after ${s.maxRuns} sends`;
  if (s.endDate) return `Ends ${s.endDate}`;
  if (s.maxRuns) return `Stops after ${s.maxRuns} sends`;
  return 'None';
}

export function missingExtraVars(
  subject: string,
  body: string,
  variables: Record<string, string>,
): string[] {
  return extraRequiredVars(extractPlaceholders(subject, body))
    .filter((k) => !String(variables[k] ?? '').trim());
}

export type WorkflowLead = {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  matchedSalt: string;
  matchedMedicine: string;
  dosageForm: string;
};

export type PreviewSummary = {
  kind: 'preview_summary';
  templateName: string;
  templateId: string;
  recipients: Array<{ id: string; name: string; email: string }>;
  scheduleLabel: string;
  timezone: string;
  endLabel: string;
  mailbox: string;
  accountId: string;
  nextSendAt: string;
  subjectPreview: string;
  bodyPreviewHtml: string;
  contract: WorkflowCommandContractV1;
};

export type MailWorkflow = {
  id: string;
  userId: string;
  createdByUserId: string;
  status: WorkflowStatus;
  executionMode: ExecutionMode;
  oneTimeSendAt: Date | null;
  templateId: string;
  recipientIds: string[];
  recipientScope: 'crm_only';
  variables: Record<string, string>;
  schedule: MailWorkflowSchedule;
  timezone: string;
  accountId: string;
  nextRunAt: Date | null;
  lastRunAt?: Date;
  runCount: number;
  failureCount: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lockId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toLead(doc: Record<string, unknown>): WorkflowLead {
  return {
    id: String(doc.id ?? ''),
    companyName: String(doc.companyName ?? ''),
    contactName: String(doc.contactName ?? ''),
    contactEmail: String(doc.contactEmail ?? ''),
    matchedSalt: String(doc.matchedSalt ?? ''),
    matchedMedicine: String(doc.matchedMedicine ?? ''),
    dosageForm: String(doc.dosageForm ?? ''),
  };
}

export function variablesFromDoc(v: unknown): Record<string, string> {
  if (v instanceof Map) return Object.fromEntries(v.entries()) as Record<string, string>;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return { ...(v as Record<string, string>) };
  }
  return {};
}

function effectiveExecutionMode(contract: WorkflowCommandContractV1): ExecutionMode {
  return executionModeOf(contract.schedule);
}

function contractSchedule(contract: WorkflowCommandContractV1): WorkflowSchedule {
  if (!contract.schedule) {
    throw new WorkflowError('SCHEDULE_INVALID', 'schedule required');
  }
  return contract.schedule;
}

/** The instant a `once` schedule fires. Absent runAt means "now". */
function onceRunAt(schedule: WorkflowSchedule): Date {
  const at = scheduleRunAt(schedule);
  return at ?? new Date();
}

export function isImmediateOneTime(contract: WorkflowCommandContractV1, now = new Date()): boolean {
  if (effectiveExecutionMode(contract) !== 'once') return false;
  return onceRunAt(contractSchedule(contract)).getTime() <= now.getTime() + 60_000;
}

/**
 * First occurrence for a freshly activated workflow.
 * `once` fires at its runAt (possibly already in the past, i.e. "send now").
 */
function firstRunAt(schedule: WorkflowSchedule, timezone: string, now = new Date()): Date | null {
  if (schedule.frequency === 'once') return onceRunAt(schedule);
  return computeNextRunAt(schedule, timezone, now);
}

export function renderLeadMessage(
  template: EmailTemplateRecord,
  lead: WorkflowLead,
  senderName: string,
  variables: Record<string, string>,
): { subject: string; html: string } {
  const vars = { ...leadVars(lead, senderName), ...variables };
  return {
    subject: applyTemplate(template.subject, vars),
    html: toHtml(applyTemplate(template.body, vars)),
  };
}

export function contractScheduleToModel(s: WorkflowSchedule): MailWorkflowSchedule {
  if (s.frequency === 'once') {
    return { frequency: 'once', runAt: s.runAt ? new Date(s.runAt) : null };
  }
  return {
    frequency: s.frequency,
    timeOfDay: s.time,
    ...(s.dayOfWeek != null ? { dayOfWeek: s.dayOfWeek } : {}),
    ...(s.dayOfMonth != null ? { dayOfMonth: s.dayOfMonth } : {}),
    ...(s.endDate ? { endDate: s.endDate } : {}),
    ...(s.maxRuns != null ? { maxRuns: s.maxRuns } : {}),
  };
}

export function modelScheduleToContract(s: MailWorkflowSchedule): WorkflowSchedule {
  if (s.frequency === 'once') {
    return { frequency: 'once', runAt: s.runAt ? new Date(s.runAt).toISOString() : undefined };
  }
  // Legacy rows stored a one-time send as daily + endDate + maxRuns:1. Read them as `once`.
  if (s.maxRuns === 1 && s.endDate && s.frequency === 'daily' && s.timeOfDay) {
    return { frequency: 'daily', time: s.timeOfDay, endDate: s.endDate, maxRuns: 1 };
  }
  return {
    frequency: s.frequency,
    time: s.timeOfDay,
    ...(s.dayOfWeek != null ? { dayOfWeek: s.dayOfWeek } : {}),
    ...(s.dayOfMonth != null ? { dayOfMonth: s.dayOfMonth } : {}),
    ...(s.endDate ? { endDate: s.endDate } : {}),
    ...(s.maxRuns != null ? { maxRuns: s.maxRuns } : {}),
  };
}

export function toMailWorkflow(doc: MailWorkflowDocument | Record<string, unknown>): MailWorkflow {
  const d = doc as MailWorkflowDocument;
  return {
    id: d.id,
    userId: d.userId,
    createdByUserId: d.createdByUserId,
    status: d.status,
    executionMode: d.executionMode ?? 'recurring',
    oneTimeSendAt: d.oneTimeSendAt ?? null,
    templateId: d.templateId,
    recipientIds: d.recipientIds,
    recipientScope: d.recipientScope,
    variables: variablesFromDoc(d.variables),
    schedule: d.schedule,
    timezone: d.timezone,
    accountId: d.accountId,
    nextRunAt: d.nextRunAt ?? null,
    ...(d.lastRunAt ? { lastRunAt: d.lastRunAt } : {}),
    runCount: d.runCount,
    failureCount: d.failureCount,
    leaseOwner: d.leaseOwner ?? null,
    leaseUntil: d.leaseUntil ?? null,
    lockId: d.lockId ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function clearLease(doc: { leaseOwner: string | null; leaseUntil: Date | null; lockId: string | null }) {
  doc.leaseOwner = null;
  doc.leaseUntil = null;
  doc.lockId = null;
}

export async function withIdempotency<T extends Record<string, unknown>>(
  userId: string,
  requestId: string,
  action: WorkflowAction,
  payload: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const existing = await MailWorkflowCommandModel.findOne({ userId, requestId }).lean();
  if (existing) return existing.result as T;

  const result = await work();
  try {
    await MailWorkflowCommandModel.create({
      id: randomUUID(),
      userId,
      requestId,
      contractVersion: CONTRACT_VERSION,
      action,
      payload,
      result: result as Record<string, unknown>,
      processedAt: new Date(),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const dup = await MailWorkflowCommandModel.findOne({ userId, requestId }).lean();
      if (dup) return dup.result as T;
    }
    throw err;
  }
  return result;
}

export async function inboxPreflight(userId: string): Promise<{
  connected: boolean;
  tokenValid: boolean;
  sendAllowed: boolean;
  accountId: string | null;
}> {
  const accounts = await findActiveOutlookAccountsByUser(userId);
  const active = accounts.filter((a) => a.status === 'active');
  if (!active.length) {
    return { connected: false, tokenValid: false, sendAllowed: false, accountId: null };
  }
  const account = active[0];
  return {
    connected: true,
    tokenValid: true,
    sendAllowed: true,
    accountId: account.id,
  };
}

export async function loadOwnedLeads(userId: string, ids: string[]): Promise<WorkflowLead[]> {
  if (!ids.length) throw new WorkflowError('RECIPIENT_NOT_FOUND', 'recipient required');
  const docs = await CrmEntities.leads.find({ userId, id: { $in: ids } }).lean();
  if (docs.length !== ids.length) {
    throw new WorkflowError('RECIPIENT_NOT_FOUND', 'recipient not found');
  }
  const byId = new Map(docs.map((doc) => [String(doc.id), toLead(doc as Record<string, unknown>)]));
  return ids.map((id) => byId.get(id)!);
}

export async function loadTemplate(userId: string, templateId: string): Promise<EmailTemplateRecord> {
  const templates = await listEmailTemplates(userId);
  const template = templates.find((t) => t.id === templateId);
  if (!template) throw new WorkflowError('TEMPLATE_MISSING', 'template not found');
  return template;
}

export function assertExtraVars(
  template: EmailTemplateRecord,
  variables: Record<string, string> = {},
): void {
  const missing = missingExtraVars(template.subject, template.body, variables);
  if (missing.length) {
    throw new WorkflowError('TEMPLATE_VARS_MISSING', `missing variables: ${missing.join(', ')}`);
  }
}

async function validateCreateContract(userId: string, contract: WorkflowCommandContractV1): Promise<void> {
  const { templateId, recipientIds } = contract;
  if (!templateId || !recipientIds?.length) {
    throw new WorkflowError('CONTRACT_INVALID', 'templateId and recipientIds are required');
  }
  if (effectiveExecutionMode(contract) === 'recurring' && !contract.schedule) {
    throw new WorkflowError('CONTRACT_INVALID', 'schedule required for recurring mode');
  }
  const template = await loadTemplate(userId, templateId);
  await loadOwnedLeads(userId, recipientIds);
  assertExtraVars(template, contract.variables ?? {});
}

async function buildPreviewInternal(
  userId: string,
  contract: WorkflowCommandContractV1,
  opts: { requireAuth: boolean },
): Promise<PreviewSummary> {
  if (contract.action !== 'create') {
    throw new WorkflowError('CONTRACT_INVALID', 'preview only supports create');
  }
  const { templateId, recipientIds } = contract;
  if (!templateId || !recipientIds?.length) {
    throw new WorkflowError('CONTRACT_INVALID', 'templateId and recipientIds are required');
  }

  const preflight = await inboxPreflight(userId);
  if (opts.requireAuth && (!preflight.connected || !preflight.accountId)) {
    throw new WorkflowError('AUTH_REQUIRED', 'outlook account required');
  }

  const [template, leads, account] = await Promise.all([
    loadTemplate(userId, templateId),
    loadOwnedLeads(userId, recipientIds),
    preflight.accountId
      ? findActiveOutlookAccountsByUser(userId).then((accounts) =>
          accounts.find((a) => a.id === preflight.accountId),
        )
      : Promise.resolve(undefined),
  ]);
  assertExtraVars(template, contract.variables ?? {});

  const user = await UserModel.findOne({ userId }).lean();
  const senderName = String(user?.name ?? '').trim() || 'Sender';
  const timezone = workflowTimezone();
  const schedule = contractSchedule(contract);
  const executionMode = effectiveExecutionMode(contract);
  const nextRunAt = firstRunAt(schedule, timezone);
  if (!nextRunAt) {
    throw new WorkflowError('SCHEDULE_INVALID', 'that schedule has no upcoming send');
  }

  const first = leads[0];
  const rendered = renderLeadMessage(template, first, senderName, contract.variables ?? {});

  return {
    kind: 'preview_summary',
    templateName: template.name,
    templateId: template.id,
    recipients: leads.map((lead) => ({
      id: lead.id,
      name: lead.contactName,
      email: lead.contactEmail,
    })),
    scheduleLabel: scheduleLabel(schedule, timezone),
    timezone,
    endLabel: endLabel(schedule),
    mailbox: account?.email ?? '',
    accountId: preflight.accountId ?? '',
    nextSendAt: nextRunAt.toISOString(),
    subjectPreview: rendered.subject,
    bodyPreviewHtml: rendered.html,
    contract,
  };
}

export async function buildPreview(
  userId: string,
  contract: WorkflowCommandContractV1,
): Promise<PreviewSummary> {
  return buildPreviewInternal(userId, contract, { requireAuth: true });
}

/** Preview without requiring a connected inbox (mailbox left empty). */
export async function buildDraftPreview(
  userId: string,
  contract: WorkflowCommandContractV1,
): Promise<PreviewSummary> {
  return buildPreviewInternal(userId, contract, { requireAuth: false });
}

export async function createWorkflow(
  userId: string,
  contract: WorkflowCommandContractV1,
  opts: { confirmed: boolean },
): Promise<MailWorkflow | PreviewSummary> {
  if (contract.action !== 'create') {
    throw new WorkflowError('CONTRACT_INVALID', 'create only');
  }
  await validateCreateContract(userId, contract);

  const { templateId, recipientIds } = contract;
  const executionMode = effectiveExecutionMode(contract);
  const preflight = await inboxPreflight(userId);

  if (preflight.sendAllowed && !opts.confirmed) {
    return buildPreview(userId, contract);
  }

  return withIdempotency(
    userId,
    contract.requestId,
    'create',
    { contract, confirmed: opts.confirmed },
    async () => {
      const timezone = workflowTimezone();
      const variables = contract.variables ?? {};
      const schedule = contractSchedule(contract);
      const scheduleDoc = contractScheduleToModel(schedule);
      const oneTimeSendAt = executionMode === 'once' ? onceRunAt(schedule) : null;

      if (preflight.sendAllowed && opts.confirmed) {
        const nextRunAt = firstRunAt(schedule, timezone);
        const doc = await MailWorkflowModel.create({
          id: randomUUID(),
          userId,
          createdByUserId: userId,
          status: 'active',
          executionMode,
          oneTimeSendAt,
          templateId: templateId!,
          recipientIds: recipientIds!,
          recipientScope: 'crm_only',
          variables,
          schedule: scheduleDoc,
          timezone,
          accountId: preflight.accountId!,
          nextRunAt,
          runCount: 0,
          failureCount: 0,
          leaseOwner: null,
          leaseUntil: null,
          lockId: null,
        });
        mailLog.info('workflow.created', {
          workspaceId: userId,
          userId,
          workflowId: doc.id,
          requestId: contract.requestId,
          frequency: schedule.frequency,
          recipients: recipientIds!.length,
        });
        // "Send now" still goes through the one durable send path; we just wake the
        // executor immediately instead of waiting for the next 30s tick.
        if (isImmediateOneTime(contract)) scheduleImmediateWake();
        return toMailWorkflow(doc.toObject()) as MailWorkflow & Record<string, unknown>;
      }

      const doc = await MailWorkflowModel.create({
        id: randomUUID(),
        userId,
        createdByUserId: userId,
        status: 'draft_requires_auth',
        executionMode,
        oneTimeSendAt,
        templateId: templateId!,
        recipientIds: recipientIds!,
        recipientScope: 'crm_only',
        variables,
        schedule: scheduleDoc,
        timezone,
        accountId: '',
        nextRunAt: null,
        runCount: 0,
        failureCount: 0,
        leaseOwner: null,
        leaseUntil: null,
        lockId: null,
      });
      return toMailWorkflow(doc.toObject()) as MailWorkflow & Record<string, unknown>;
    },
  );
}

export async function confirmWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(
    userId,
    requestId,
    'create',
    { workflowId, confirm: true },
    async () => {
      const wf = await MailWorkflowModel.findOne({ userId, id: workflowId });
      if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
      // Already active: confirming twice is a no-op, not an error (double-click / retry).
      if (wf.status === 'active') {
        return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
      }
      if (wf.status !== 'pending_confirm' && wf.status !== 'paused_auth_required') {
        throw new WorkflowError('CONTRACT_INVALID', 'this scheduled email is not awaiting confirmation');
      }

      const preflight = await inboxPreflight(userId);
      if (!preflight.sendAllowed || !preflight.accountId) {
        throw new WorkflowError('AUTH_REQUIRED', 'Connect your Outlook account to continue.', 409);
      }

      const schedule = modelScheduleToContract(wf.schedule);
      const nextRunAt = firstRunAt(schedule, wf.timezone);
      if (!nextRunAt) {
        throw new WorkflowError(
          'SCHEDULE_INVALID',
          'That send time has already passed. Tell me a new time and I will reschedule it.',
        );
      }

      wf.status = 'active';
      wf.accountId = preflight.accountId;
      wf.nextRunAt = nextRunAt;
      await wf.save();
      mailLog.info('workflow.confirmed', {
        workspaceId: userId, userId, workflowId, requestId, nextRunAt,
      });
      if (nextRunAt.getTime() <= Date.now() + 60_000) scheduleImmediateWake();
      return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
    },
  );
}

/**
 * A conditional update that matched nothing means either the workflow is gone or it
 * changed state underneath us (a concurrent cancel, for example). Re-read so the caller
 * gets a truthful reason rather than a generic failure.
 */
async function explainFailedTransition(
  userId: string,
  workflowId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<WorkflowError> {
  const current = await MailWorkflowModel.findOne({ userId, id: workflowId }).lean();
  if (!current) return new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
  if (action === 'cancel') {
    return new WorkflowError('CONTRACT_INVALID', 'workflow already terminal');
  }
  if (action === 'pause') {
    return new WorkflowError('CONTRACT_INVALID', 'workflow not active');
  }
  return new WorkflowError('CONTRACT_INVALID', 'workflow not paused');
}

export async function pauseWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(userId, requestId, 'pause', { workflowId }, async () => {
    // Conditional on status: a concurrent cancel must not be silently overwritten.
    const wf = await MailWorkflowModel.findOneAndUpdate(
      { userId, id: workflowId, status: 'active' },
      { $set: { status: 'paused', leaseOwner: null, leaseUntil: null, lockId: null } },
      { new: true },
    ).lean();
    if (wf) {
      mailLog.info('workflow.paused', { workspaceId: userId, userId, workflowId, requestId });
      return toMailWorkflow(wf) as MailWorkflow & Record<string, unknown>;
    }
    throw await explainFailedTransition(userId, workflowId, 'pause');
  });
}

export async function resumeWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(userId, requestId, 'resume', { workflowId }, async () => {
    const current = await MailWorkflowModel.findOne({ userId, id: workflowId }).lean();
    if (!current) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
    if (current.status === 'paused_auth_required') {
      throw new WorkflowError(
        'AUTH_REQUIRED',
        'Reconnect your Outlook account first, then confirm this scheduled email again.',
        409,
      );
    }
    if (current.status !== 'paused') {
      throw new WorkflowError('CONTRACT_INVALID', 'workflow not paused');
    }
    const resumeAt = computeNextRunAt(
      modelScheduleToContract(current.schedule),
      current.timezone,
      new Date(),
    );
    if (!resumeAt) {
      // A one-time send whose moment has passed cannot simply be un-paused.
      throw new WorkflowError(
        'SCHEDULE_INVALID',
        'That send time has already passed, so there is nothing left to resume. Tell me a new time and I will set it up again.',
      );
    }
    const wf = await MailWorkflowModel.findOneAndUpdate(
      { userId, id: workflowId, status: 'paused' },
      { $set: { status: 'active', nextRunAt: resumeAt } },
      { new: true },
    ).lean();
    if (!wf) throw await explainFailedTransition(userId, workflowId, 'resume');
    mailLog.info('workflow.resumed', { workspaceId: userId, userId, workflowId, requestId });
    return toMailWorkflow(wf) as MailWorkflow & Record<string, unknown>;
  });
}

export async function cancelWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(userId, requestId, 'cancel', { workflowId }, async () => {
    const wf = await MailWorkflowModel.findOneAndUpdate(
      { userId, id: workflowId, status: { $nin: [...TERMINAL_STATUSES] } },
      {
        $set: {
          status: 'cancelled',
          nextRunAt: null,
          leaseOwner: null,
          leaseUntil: null,
          lockId: null,
        },
      },
      { new: true },
    ).lean();
    if (!wf) throw await explainFailedTransition(userId, workflowId, 'cancel');
    mailLog.info('workflow.cancelled', { workspaceId: userId, userId, workflowId, requestId });
    return toMailWorkflow(wf) as MailWorkflow & Record<string, unknown>;
  });
}

export async function updateWorkflow(
  userId: string,
  workflowId: string,
  contract: WorkflowCommandContractV1,
): Promise<MailWorkflow> {
  return withIdempotency(
    userId,
    contract.requestId,
    'update',
    { workflowId, contract },
    async () => {
      const wf = await MailWorkflowModel.findOne({ userId, id: workflowId });
      if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');

      if (contract.templateId) {
        await loadTemplate(userId, contract.templateId);
        wf.templateId = contract.templateId;
      }
      if (contract.recipientIds) {
        await loadOwnedLeads(userId, contract.recipientIds);
        wf.recipientIds = contract.recipientIds;
      }
      if (contract.variables) {
        wf.variables = contract.variables as unknown as MailWorkflowDocument['variables'];
      }
      if (contract.schedule) {
        wf.schedule = contractScheduleToModel(contract.schedule);
      }

      const template = await loadTemplate(userId, wf.templateId);
      assertExtraVars(template, variablesFromDoc(wf.variables));

      if (wf.status === 'active' && contract.schedule) {
        wf.nextRunAt = firstRunAt(modelScheduleToContract(wf.schedule), wf.timezone);
      }

      await wf.save();
      return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
    },
  );
}

export async function getWorkflow(userId: string, workflowId: string): Promise<MailWorkflow> {
  const wf = await MailWorkflowModel.findOne({ userId, id: workflowId }).lean();
  if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
  return toMailWorkflow(wf);
}

export async function listWorkflows(userId: string): Promise<MailWorkflow[]> {
  const docs = await MailWorkflowModel.find({ userId }).sort({ updatedAt: -1 }).lean();
  return docs.map((doc) => toMailWorkflow(doc));
}

export async function listRuns(
  userId: string,
  workflowId: string,
): Promise<MailWorkflowRunDocument[]> {
  const wf = await MailWorkflowModel.findOne({ userId, id: workflowId }).lean();
  if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
  return MailWorkflowRunModel.find({ userId, workflowId }).sort({ scheduledAt: -1 }).lean();
}

export async function listExecutions(
  userId: string,
  query: { status?: RunStatus; from?: string; to?: string } = {},
): Promise<MailWorkflowRunDocument[]> {
  const filter: Record<string, unknown> = { userId };
  if (query.status) filter.status = query.status;
  if (query.from || query.to) {
    const scheduledAt: Record<string, Date> = {};
    if (query.from) scheduledAt.$gte = new Date(query.from);
    if (query.to) scheduledAt.$lte = new Date(query.to);
    filter.scheduledAt = scheduledAt;
  }
  return MailWorkflowRunModel.find(filter).sort({ scheduledAt: -1 }).lean();
}

/**
 * After a reconnect, move anything blocked on auth into `pending_confirm`.
 * Deliberately does NOT reactivate: the user must confirm each one explicitly
 * (see confirmWorkflow) so nothing starts sending behind their back.
 */
export async function promoteDraftsAfterReconnect(userId: string): Promise<MailWorkflow[]> {
  const preflight = await inboxPreflight(userId);
  if (!preflight.sendAllowed) return [];

  await MailWorkflowModel.updateMany(
    { userId, status: { $in: ['draft_requires_auth', 'paused_auth_required'] } },
    { $set: { status: 'pending_confirm', nextRunAt: null } },
  );

  const docs = await MailWorkflowModel.find({ userId, status: 'pending_confirm' }).lean();
  mailLog.info('workflow.promoted_after_reconnect', {
    workspaceId: userId,
    userId,
    count: docs.length,
  });
  return docs.map((doc) => toMailWorkflow(doc));
}

/** Runs whose provider outcome could not be determined - surfaced for operator recovery. */
export async function listRunsNeedingReview(userId: string): Promise<MailWorkflowRunDocument[]> {
  return MailWorkflowRunModel.find({ userId, needsOperatorReview: true })
    .sort({ scheduledAt: -1 })
    .limit(100)
    .lean();
}

if (process.argv[1]?.endsWith('workflow.service.ts')) {
  const weekly = { frequency: 'weekly' as const, time: '10:00', dayOfWeek: 1 };
  const label = scheduleLabel(weekly, 'Asia/Kolkata');
  assert.ok(label.includes('Monday'));
  assert.ok(label.includes('10:00'));

  assert.equal(endLabel({ frequency: 'daily', time: '10:00' }), 'None');
  assert.equal(endLabel({ frequency: 'daily', time: '10:00', endDate: '2026-12-31' }), 'Ends 2026-12-31');
  assert.equal(endLabel({ frequency: 'daily', time: '10:00', maxRuns: 8 }), 'Stops after 8 sends');
  assert.equal(
    endLabel({ frequency: 'daily', time: '10:00', endDate: '2026-12-31', maxRuns: 8 }),
    'Ends 2026-12-31 or after 8 sends',
  );

  assert.deepEqual(
    missingExtraVars('Hi {{contact_name}}', 'Status: {{status}}', { contact_name: 'A' }),
    ['status'],
  );
  assert.deepEqual(missingExtraVars('Hi', 'Body', { status: '  ' }), []);
  const onceContract: WorkflowCommandContractV1 = {
    version: 'v1',
    action: 'create',
    executionMode: 'once',
    schedule: { frequency: 'once', runAt: '2026-12-31T10:00:00.000Z' },
    templateId: 't1',
    recipientIds: ['r1'],
    confidence: 1,
    requestId: 'x',
  };
  // `once` is a real frequency now - no maxRuns=1 stand-in anywhere in the pipeline
  assert.equal(contractScheduleToModel(onceContract.schedule!).frequency, 'once');
  assert.equal(contractScheduleToModel(onceContract.schedule!).maxRuns, undefined);
  assert.equal(isImmediateOneTime(onceContract), false, 'a future one-time send is not immediate');
  assert.equal(
    isImmediateOneTime({ ...onceContract, schedule: { frequency: 'once', runAt: new Date().toISOString() } }),
    true,
  );
  assert.equal(endLabel({ frequency: 'once', runAt: '2026-12-31T10:00:00.000Z' }), 'Single send');
  assert.match(scheduleLabel({ frequency: 'once', runAt: '2026-12-31T10:00:00.000Z' }, 'UTC'), /Send once/);

  // legacy daily+maxRuns:1 rows still read back without crashing
  assert.equal(
    modelScheduleToContract({ frequency: 'daily', timeOfDay: '10:00', endDate: '2026-12-31', maxRuns: 1 }).maxRuns,
    1,
  );

  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 11001 }), false);

  const run = async () => {
    if (process.env.MONGODB_URI) {
      await connectMongo();
      const userId = 'wf-selfcheck-user';
      const requestId = `wf-selfcheck-${randomUUID()}`;
      let calls = 0;
      const r1 = await withIdempotency(
        userId,
        requestId,
        'list',
        {},
        async () => {
          calls++;
          return { ok: true, n: calls };
        },
      );
      const r2 = await withIdempotency(
        userId,
        requestId,
        'list',
        {},
        async () => {
          calls++;
          return { ok: false, n: calls };
        },
      );
      assert.deepEqual(r1, r2);
      assert.equal(calls, 1);
      await MailWorkflowCommandModel.deleteOne({ userId, requestId });
    } else {
      console.log('skip mongo idempotency');
    }
    console.log('workflow.service self-check passed');
  };

  void run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
