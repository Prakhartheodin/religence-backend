import assert from 'node:assert/strict';

import { MailWorkflowRunModel } from '../../models/mail-workflow-run.model.js';
import type { MailWorkflowRunRecipient } from '../../models/mail-workflow-run.model.js';
import { MailWorkflowModel } from '../../models/mail-workflow.model.js';
import { findSentMessageByInternetId } from '../outlook.service.js';
import { listEmailTemplates } from '../email-templates.service.js';
import { WorkflowError } from './contract.js';
import type { RecipientSendStatus, RunStatus } from './contract.js';

/** Cap the scan so a workspace with years of sends still answers in one query. */
// ponytail: 2000 scan cap; paginate history when workspaces exceed ~100 active sequences.
const RUN_SCAN_LIMIT = 2000;
/** What the assistant gets as long-term context — small enough to sit in a prompt. */
const MEMORY_CONTACT_LIMIT = 20;
const MEMORY_EVENTS_PER_CONTACT = 3;

export type MailHistoryEvent = {
  runId: string;
  workflowId: string;
  recipientId: string;
  templateId: string;
  templateName: string;
  subject: string;
  /** When the send was scheduled to go out. */
  scheduledAt: string;
  /** When Graph accepted it. Null while pending, failed, or unknown. */
  sentAt: string | null;
  status: RecipientSendStatus;
  runStatus: RunStatus;
  errorCode?: string;
  errorMessage?: string;
  /** True when we hold an id that can resolve to a real mailbox message. */
  linkable: boolean;
};

export type MailHistoryContact = {
  /** CRM lead id. Stable key; falls back to the email if the lead id was lost. */
  contactId: string;
  name: string;
  company: string;
  email: string;
  totalSent: number;
  totalFailed: number;
  firstContactedAt: string | null;
  lastContactedAt: string | null;
  events: MailHistoryEvent[];
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Group key: prefer the CRM id, fall back to the email so orphaned sends still group. */
export function contactKey(r: Pick<MailWorkflowRunRecipient, 'recipientId' | 'email'>): string {
  return r.recipientId || `email:${(r.email || '').toLowerCase()}`;
}

/**
 * A recipient row is worth showing once we actually tried to send it. `pending` rows are
 * future work, not history, and would otherwise make a scheduled run look like a sent one.
 */
export function isHistoricalRecipient(r: Pick<MailWorkflowRunRecipient, 'status'>): boolean {
  return r.status !== 'pending';
}

export async function listMailHistory(
  userId: string,
  opts: { contactId?: string; limit?: number } = {},
): Promise<MailHistoryContact[]> {
  const [runs, workflows, templates] = await Promise.all([
    MailWorkflowRunModel.find({ userId })
      .sort({ scheduledAt: -1 })
      .limit(RUN_SCAN_LIMIT)
      .lean(),
    MailWorkflowModel.find({ userId }).select('id templateId').lean(),
    listEmailTemplates(userId),
  ]);

  const templateIdByWorkflow = new Map(workflows.map((wf) => [String(wf.id), String(wf.templateId)]));
  const templateNameById = new Map(templates.map((t) => [t.id, t.name]));

  const byContact = new Map<string, MailHistoryContact>();

  for (const run of runs) {
    for (const r of run.recipients ?? []) {
      if (!isHistoricalRecipient(r)) continue;
      const key = contactKey(r);
      if (opts.contactId && key !== opts.contactId && r.recipientId !== opts.contactId) continue;

      const templateId = (run.templateId || templateIdByWorkflow.get(run.workflowId)) ?? '';
      const event: MailHistoryEvent = {
        runId: run.id,
        workflowId: run.workflowId,
        recipientId: r.recipientId,
        templateId,
        templateName: templateNameById.get(templateId) ?? 'Deleted template',
        subject: r.subject || templateNameById.get(templateId) || '(no subject recorded)',
        scheduledAt: toIso(run.scheduledAt) ?? '',
        sentAt: toIso(r.acceptedAt),
        status: r.status,
        runStatus: run.status,
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
        linkable: Boolean(r.internetMessageId) && r.status === 'sent',
      };

      let contact = byContact.get(key);
      if (!contact) {
        contact = {
          contactId: key,
          name: r.contactName || r.email || 'Unknown contact',
          company: r.companyName || '',
          email: r.email || '',
          totalSent: 0,
          totalFailed: 0,
          firstContactedAt: null,
          lastContactedAt: null,
          events: [],
        };
        byContact.set(key, contact);
      }
      // Runs arrive newest-first, so the last row we see is the oldest. Keep the newest
      // non-empty name/company: the earliest snapshot may predate a CRM correction.
      if (!contact.name && r.contactName) contact.name = r.contactName;
      if (!contact.company && r.companyName) contact.company = r.companyName;

      if (r.status === 'sent') contact.totalSent += 1;
      if (r.status === 'failed') contact.totalFailed += 1;

      const stamp = event.sentAt ?? event.scheduledAt;
      if (stamp) {
        if (!contact.lastContactedAt || stamp > contact.lastContactedAt) contact.lastContactedAt = stamp;
        if (!contact.firstContactedAt || stamp < contact.firstContactedAt) contact.firstContactedAt = stamp;
      }
      contact.events.push(event);
    }
  }

  const contacts = [...byContact.values()].sort((a, b) =>
    (b.lastContactedAt ?? '').localeCompare(a.lastContactedAt ?? ''),
  );
  return opts.limit ? contacts.slice(0, opts.limit) : contacts;
}

/**
 * Resolves one timeline row to the real message in the mailbox. Deliberately lazy —
 * done on click, not on panel load, so opening the panel never fans out N Graph calls.
 */
export async function resolveMailLink(
  userId: string,
  runId: string,
  recipientId: string,
): Promise<{ webLink: string | null; conversationId: string | null; sentAt: string | null }> {
  const run = await MailWorkflowRunModel.findOne({ userId, id: runId }).lean();
  if (!run) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'run not found', 404);

  const recipient = (run.recipients ?? []).find((r) => r.recipientId === recipientId);
  if (!recipient) throw new WorkflowError('RECIPIENT_NOT_FOUND', 'recipient not found on this run', 404);
  if (!recipient.internetMessageId) {
    throw new WorkflowError('RECIPIENT_NOT_FOUND', 'this send has no mailbox message to open', 404);
  }

  const wf = await MailWorkflowModel.findOne({ userId, id: run.workflowId }).select('accountId').lean();
  if (!wf?.accountId) throw new WorkflowError('AUTH_REQUIRED', 'no mailbox connected for this send');

  const found = await findSentMessageByInternetId(userId, wf.accountId, recipient.internetMessageId);
  if (!found) {
    throw new WorkflowError('WORKFLOW_NOT_FOUND', 'could not find this message in the mailbox', 404);
  }
  return { webLink: found.webLink, conversationId: found.conversationId, sentAt: found.sentDateTime };
}

/**
 * Compact per-contact history for the chat model's system prompt — the "who have I
 * already emailed, and when" memory. One line per contact, newest first.
 */
export async function buildMailMemory(userId: string): Promise<
  Array<{ name: string; email: string; lastContactedAt: string | null; sent: number; recent: string[] }>
> {
  const contacts = await listMailHistory(userId, { limit: MEMORY_CONTACT_LIMIT });
  return contacts.map((c) => ({
    name: c.name,
    email: c.email,
    lastContactedAt: c.lastContactedAt,
    sent: c.totalSent,
    recent: c.events
      .slice(0, MEMORY_EVENTS_PER_CONTACT)
      .map((e) => `${(e.sentAt ?? e.scheduledAt).slice(0, 10)} ${e.subject} [${e.status}]`),
  }));
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('mail-history.ts')) {
  // --- grouping falls back to email when the CRM id is gone ---
  assert.equal(contactKey({ recipientId: 'lead-1', email: 'a@b.com' }), 'lead-1');
  assert.equal(contactKey({ recipientId: '', email: 'A@B.com' }), 'email:a@b.com');

  // --- pending is future work, not history ---
  assert.equal(isHistoricalRecipient({ status: 'pending' }), false);
  assert.equal(isHistoricalRecipient({ status: 'sent' }), true);
  assert.equal(isHistoricalRecipient({ status: 'failed' }), true);
  assert.equal(
    isHistoricalRecipient({ status: 'unknown' }),
    true,
    'an unknown outcome must stay visible — it is exactly what a human needs to check',
  );

  console.log('mail-history self-check passed');
}
