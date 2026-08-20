import assert from 'node:assert/strict';
import { CrmEntities } from '../../models/crm-entities.js';
import { UserModel } from '../../models/user.model.js';
import { listEmailTemplates, type EmailTemplateRecord } from '../email-templates.service.js';
import { findActiveOutlookAccountsByUser } from '../outlook-store.js';
import {
  WorkflowError,
  type WorkflowCommandContractV1,
  type WorkflowSchedule,
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

  console.log('workflow.service self-check passed');
}
