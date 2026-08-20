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
import {
  CONTRACT_VERSION,
  WorkflowError,
  type RunStatus,
  type WorkflowAction,
  type WorkflowCommandContractV1,
  type WorkflowSchedule,
  type WorkflowStatus,
} from './contract.js';
import { computeNextRunAt } from './recurrence.js';
import {
  applyTemplate,
  extractPlaceholders,
  extraRequiredVars,
  leadVars,
  toHtml,
} from './render.js';

const ISO_DOW = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

const TERMINAL_STATUSES = new Set<WorkflowStatus>(['completed', 'cancelled']);

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

function workflowTimezone(): string {
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

export function scheduleLabel(s: WorkflowSchedule, _tz: string): string {
  const at = formatTime12(s.time);
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

export function endLabel(s: WorkflowSchedule): string {
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

export function contractScheduleToModel(s: WorkflowSchedule): MailWorkflowSchedule {
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
  const { templateId, recipientIds, schedule } = contract;
  if (!templateId || !recipientIds?.length || !schedule) {
    throw new WorkflowError('CONTRACT_INVALID', 'templateId, recipientIds, and schedule required');
  }
  const template = await loadTemplate(userId, templateId);
  await loadOwnedLeads(userId, recipientIds);
  assertExtraVars(template, contract.variables ?? {});
}

export async function buildPreview(
  userId: string,
  contract: WorkflowCommandContractV1,
): Promise<PreviewSummary> {
  if (contract.action !== 'create') {
    throw new WorkflowError('CONTRACT_INVALID', 'preview only supports create');
  }
  const { templateId, recipientIds, schedule } = contract;
  if (!templateId || !recipientIds?.length || !schedule) {
    throw new WorkflowError('CONTRACT_INVALID', 'templateId, recipientIds, and schedule required');
  }

  const preflight = await inboxPreflight(userId);
  if (!preflight.connected || !preflight.accountId) {
    throw new WorkflowError('AUTH_REQUIRED', 'outlook account required');
  }

  const [template, leads, account] = await Promise.all([
    loadTemplate(userId, templateId),
    loadOwnedLeads(userId, recipientIds),
    findActiveOutlookAccountsByUser(userId).then((accounts) => accounts.find((a) => a.id === preflight.accountId)),
  ]);
  assertExtraVars(template, contract.variables ?? {});

  const user = await UserModel.findOne({ userId }).lean();
  const senderName = String(user?.name ?? '').trim() || 'Sender';
  const timezone = workflowTimezone();
  const nextRunAt = computeNextRunAt(schedule, timezone, new Date());

  const first = leads[0];
  const vars = { ...leadVars(first, senderName), ...(contract.variables ?? {}) };
  const subjectPreview = applyTemplate(template.subject, vars);
  const bodyPreviewHtml = toHtml(applyTemplate(template.body, vars));

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
    accountId: preflight.accountId,
    nextSendAt: nextRunAt.toISOString(),
    subjectPreview,
    bodyPreviewHtml,
    contract,
  };
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

  const { templateId, recipientIds, schedule } = contract;
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
      const scheduleDoc = contractScheduleToModel(schedule!);

      if (preflight.sendAllowed && opts.confirmed) {
        const nextRunAt = computeNextRunAt(schedule!, timezone, new Date());
        const doc = await MailWorkflowModel.create({
          id: randomUUID(),
          userId,
          createdByUserId: userId,
          status: 'active',
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
        return toMailWorkflow(doc.toObject()) as MailWorkflow & Record<string, unknown>;
      }

      const doc = await MailWorkflowModel.create({
        id: randomUUID(),
        userId,
        createdByUserId: userId,
        status: 'draft_requires_auth',
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
      if (wf.status !== 'pending_confirm') {
        throw new WorkflowError('CONTRACT_INVALID', 'workflow not pending confirm');
      }

      const preflight = await inboxPreflight(userId);
      if (!preflight.sendAllowed || !preflight.accountId) {
        throw new WorkflowError('AUTH_REQUIRED', 'outlook account required');
      }

      wf.status = 'active';
      wf.accountId = preflight.accountId;
      wf.nextRunAt = computeNextRunAt(modelScheduleToContract(wf.schedule), wf.timezone, new Date());
      await wf.save();
      return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
    },
  );
}

export async function pauseWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(userId, requestId, 'pause', { workflowId }, async () => {
    const wf = await MailWorkflowModel.findOne({ userId, id: workflowId });
    if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
    if (wf.status !== 'active') {
      throw new WorkflowError('CONTRACT_INVALID', 'workflow not active');
    }
    wf.status = 'paused';
    clearLease(wf);
    await wf.save();
    return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
  });
}

export async function resumeWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(userId, requestId, 'resume', { workflowId }, async () => {
    const wf = await MailWorkflowModel.findOne({ userId, id: workflowId });
    if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
    if (wf.status !== 'paused') {
      throw new WorkflowError('CONTRACT_INVALID', 'workflow not paused');
    }
    wf.status = 'active';
    wf.nextRunAt = computeNextRunAt(modelScheduleToContract(wf.schedule), wf.timezone, new Date());
    await wf.save();
    return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
  });
}

export async function cancelWorkflow(
  userId: string,
  workflowId: string,
  requestId: string,
): Promise<MailWorkflow> {
  return withIdempotency(userId, requestId, 'cancel', { workflowId }, async () => {
    const wf = await MailWorkflowModel.findOne({ userId, id: workflowId });
    if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');
    if (TERMINAL_STATUSES.has(wf.status)) {
      throw new WorkflowError('CONTRACT_INVALID', 'workflow already terminal');
    }
    wf.status = 'cancelled';
    wf.nextRunAt = null;
    clearLease(wf);
    await wf.save();
    return toMailWorkflow(wf.toObject()) as MailWorkflow & Record<string, unknown>;
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
        wf.nextRunAt = computeNextRunAt(
          modelScheduleToContract(wf.schedule),
          wf.timezone,
          new Date(),
        );
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

export async function promoteDraftsAfterReconnect(userId: string): Promise<MailWorkflow[]> {
  const preflight = await inboxPreflight(userId);
  if (!preflight.sendAllowed) return [];

  await MailWorkflowModel.updateMany(
    { userId, status: 'draft_requires_auth' },
    { $set: { status: 'pending_confirm' } },
  );

  const docs = await MailWorkflowModel.find({ userId, status: 'pending_confirm' }).lean();
  return docs.map((doc) => toMailWorkflow(doc));
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
