import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import config from '../../config.js';
import { CrmEntities } from '../../models/crm-entities.js';
import { listEmailTemplates } from '../email-templates.service.js';
import { buildMailMemory } from './mail-history.js';
import {
  executionModeOf,
  parseContract,
  WorkflowError,
  type WorkflowAction,
  type WorkflowCommandContractV1,
  type WorkflowSchedule,
} from './contract.js';
import {
  clearAsked,
  computeMissingFields,
  noteAsked,
  draftHasAnyInput,
  draftIsComplete,
  draftIsIdle,
  emptyDraft,
  isActiveCreateFlow,
  isOnceDraft,
  needsCreateStepRouting,
  refreshDraftSteps,
  toAwaitingCreateConfirmation,
  toAwaitingManagementConfirmation,
  toCollecting,
  toEditing,
  type ConversationDraft,
  type DraftChoice,
  type MissingField,
} from './chat-draft.js';
import {
  clearMailChatSession,
  loadConversationDraft,
  saveConversationDraft,
} from './chat-session.service.js';
import type {
  AssistantMessage,
  ChatMessageInput,
  ChatMessageResult,
} from './chat-types.js';

export type {
  AssistantChoice,
  AssistantConfirmAction,
  AssistantMessage,
  ChatConfirm,
  ChatMessageInput,
  ChatMessageResult,
  ChatMessageResponse,
  ClarificationPrompt,
  CommandResult,
} from './chat-types.js';

import {
  parseSlashCommand,
  slashCreateMessage,
  slashHelpMessage,
  slashSendMessage,
  slashUnknownMessage,
} from './slash-commands.js';
import { isImmediatePhrase, parseWhen } from './chat-time.js';
import { mailLog } from './log.js';
import {
  buildDraftPreview,
  cancelWorkflow,
  createWorkflow,
  getWorkflow,
  inboxPreflight,
  listRuns,
  listWorkflows,
  loadTemplate,
  missingExtraVars,
  modelScheduleToContract,
  pauseWorkflow,
  resumeWorkflow,
  scheduleLabel,
  workflowTimezone,
  type MailWorkflow,
  type PreviewSummary,
} from './workflow.service.js';

const LLM_TIMEOUT_MS = 9000;
const LEAD_CONTEXT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Draft persistence
// ---------------------------------------------------------------------------

async function getDraft(userId: string): Promise<ConversationDraft> {
  return refreshDraftSteps(await loadConversationDraft(userId));
}

async function saveDraft(userId: string, draft: ConversationDraft): Promise<void> {
  await saveConversationDraft(userId, refreshDraftSteps(draft));
}

async function clearDraft(userId: string): Promise<void> {
  await saveConversationDraft(userId, emptyDraft());
}

export async function clearConversationDraft(userId: string): Promise<void> {
  await clearMailChatSession(userId);
}

// ---------------------------------------------------------------------------
// Text classifiers — deterministic, run ahead of the LLM
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const GREETING_WORDS = /^(hi|hii+|hey+|hello|howdy|yo|sup|help|\?+|hm+|huh)$/;

function isGreeting(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.,…]+$/, '');
  if (!t) return true;
  if (GREETING_WORDS.test(t)) return true;
  return /^good (morning|afternoon|evening)$/.test(t);
}

function stripPoliteness(text: string): string {
  return normalize(text)
    .replace(/\b(please|thanks|thank you|pls)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fully anchored: a prefix match made "send it to Rahul instead" confirm the send.
const CONFIRM_PHRASES =
  /^(y|yes|yep|yeah|yup|ya|ok|okay|k|sure|confirm|confirmed|go ahead|do it|send it|send it now|send now|now send it|schedule it|schedule|looks good|lgtm|perfect|go for it|please do|thats right|correct)$/;
const CANCEL_PHRASES =
  /^(n|no|nope|nah|cancel|cancel it|cancel that|stop|never mind|nevermind|dont|do not|don t|not now|forget it|discard)$/;

/**
 * The subset of CONFIRM_PHRASES that means yes regardless of what is being confirmed.
 * Excludes send-flavoured wording, which only makes sense for a send.
 */
const EXPLICIT_YES =
  /^(y|yes|yep|yeah|yup|ya|ok|okay|k|sure|confirm|confirmed|go ahead|do it|please do|thats right|correct|looks good|lgtm)$/;

export function isNaturalConfirmReply(text: string): boolean {
  return CONFIRM_PHRASES.test(stripPoliteness(text));
}

export function isExplicitYes(text: string): boolean {
  return EXPLICIT_YES.test(stripPoliteness(text));
}

export function isNaturalCancelReply(text: string): boolean {
  return CANCEL_PHRASES.test(stripPoliteness(text));
}

/** Only a bare "edit"/"change it" gets the canned prompt; anything with content is applied. */
export function isBareEditRequest(text: string): boolean {
  const t = stripPoliteness(text);
  if (!/\b(edit|change|update|modify|amend|redo)\b/.test(t)) return false;
  return t.split(' ').filter(Boolean).length <= 3;
}

/** Only these words let the model pull us out of an in-progress create flow. */
export function hasExplicitManagementIntent(text: string): boolean {
  const t = normalize(text);
  return /\b(pause|unpause|resume|cancel|stop it|delete|remove|list|my scheduled|scheduled emails|what.*scheduled)\b/.test(t);
}

export function isTemplateListQuery(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (/\b(leads?|recipients?|contacts?|companies|customers)\b/.test(t)) return false;
  if (/\b(how many|what|which|show|list)\b.*\btemplates?\b/.test(t)) return true;
  if (/\btemplates?\s+(how many|do we have|available|list)\b/.test(t)) return true;
  if (/\b(how many|what|which)\b.*\b(do we have|do you have|are there|is available|are available|available)\b/.test(t)) {
    return true;
  }
  return /\bwhat do we have\b/.test(t);
}

// ponytail: fuzzy on the verb rather than literal phrases, so typos ("did you sned it")
// and short forms ("sent?", "is it sent yet") still route to the status answer.
// Upgrade path: real intent classification if the typo list keeps growing.
const SENT_VERB = '(?:sent|send|sended|sned|snet|snd|sedn|sendt|sent it)';
const DELIVERY_STATUS_RE = new RegExp(
  [
    `\\b(?:did|has|have|was|were|is|are)\\b[a-z0-9 ]{0,20}\\b${SENT_VERB}\\b`,
    `\\b${SENT_VERB}\\b[a-z0-9 ]{0,12}\\b(?:yet|already|or not|ok|confirmed|successfully)\\b`,
    '\\b(?:send|delivery|mail|email) status\\b',
    '\\bdid it go out\\b',
    `^${SENT_VERB}$`,
  ].join('|'),
);

function isDeliveryStatusQuery(text: string): boolean {
  return DELIVERY_STATUS_RE.test(normalize(text));
}

/**
 * A real clock/calendar token. A bare "at" or "schedule" used to qualify, which meant a
 * template called "Quotation at Best Rate" — or a reply of "the one at the top" — was read
 * as a schedule change and never reached the template matcher.
 */
const TIME_TOKEN =
  /\b(\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}:\d{2}|daily|weekly|monthly|monday|tuesday|wednesday|thursday|friday|saturday|sunday|every|tomorrow|today|tonight|now|asap|noon|midnight)\b/;

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
};

/**
 * Resolves "2", "the second one", "option 3" against an outstanding shortlist. Templates
 * already accepted a bare number; people did not, so "2" was scored as a contact name,
 * matched nobody, and the same question came back. Runs before the LLM.
 */
export function parseChoiceOrdinal(text: string, count: number): number | null {
  const t = normalize(text);
  if (!t || count <= 0) return null;

  const numeric = t.match(/^(?:the\s+)?(?:no|number|option|choice|pick)?\s*(\d{1,2})(?:\s+one)?$/);
  if (numeric) {
    const n = Number.parseInt(numeric[1], 10);
    return n >= 1 && n <= count ? n : null;
  }

  const word = t.match(/^(?:the\s+)?(?:no|number|option|choice|pick)?\s*([a-z0-9]+)(?:\s+one)?$/);
  const n = word ? ORDINAL_WORDS[word[1]] : undefined;
  return n && n <= count ? n : null;
}

/** "help" mid-flow must not dump the user back at the welcome message. */
export function isHelpRequest(text: string): boolean {
  const t = stripPoliteness(text);
  return /^(help|help me|i need help|what can i do|what can you do|how does this work|how do i do this|what now|options|what are my options)$/.test(t);
}

/** "you pick" is not an answer — but it is not nonsense either, so answer it as itself. */
export function isDeflection(text: string): boolean {
  const t = stripPoliteness(text);
  return /^(you (pick|decide|choose)|your (call|choice)|up to you|idk|i don t know|i dont know|dunno|no idea|doesn t matter|does not matter|dont care|do not care|whatever|anything|anything is fine|any|any one|no preference)$/.test(t);
}

/**
 * A question, not an instruction. Deliberately shallow — it exists to stop the preview's
 * confirmation being torn down, not to understand what was asked. Callers must check the
 * correction classifiers first so "make it 3pm?" still reads as an edit.
 */
export function looksLikeQuestion(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (raw.endsWith('?')) return true;
  return isTemplateListQuery(raw) || isDeliveryStatusQuery(raw);
}

export function looksLikeScheduleCorrection(text: string): boolean {
  const t = normalize(text);
  // "change the time" carries the intent without naming a time yet.
  return TIME_TOKEN.test(t) || /\bchange\b.*\btime\b/.test(t);
}

export function looksLikeRecipientCorrection(text: string): boolean {
  const t = normalize(text);
  // A bare "add" is not evidence — it appears in ordinary template names.
  return (
    /\b(instead|rather|forget)\b/.test(t)
    || /\bsend (it )?to\b/.test(t)
    || /\bchange\b.*\brecipients?\b/.test(t)
    || /\balso add\b/.test(t)
  );
}

function scoreMatch(haystack: string, needle: string): number {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return 0;
  if (h === n) return 100;
  if (h.includes(n) || n.includes(h)) return 85;
  const nWords = n.split(' ').filter(Boolean);
  const hWords = new Set(h.split(' ').filter(Boolean));
  const overlap = nWords.filter((w) => hWords.has(w)).length;
  if (!nWords.length) return 0;
  return Math.round((overlap / nWords.length) * 70);
}

function greetingMessage(): AssistantMessage {
  return {
    kind: 'assistant_message',
    message:
      "Hey! I can help you create and manage recurring or one-time emails.\n\nTell me what you'd like to send, who it's for, and when you'd like it sent.",
    suggestions: ['Send the weekly project update to Rahul every Monday at 10 AM.'],
  };
}

// ---------------------------------------------------------------------------
// LLM — extraction only, never state mutation
// ---------------------------------------------------------------------------

type LlmInterpretation = {
  action?: WorkflowAction;
  templateHint?: string | null;
  templateId?: string | null;
  recipientHints?: string[] | null;
  recipientIds?: string[] | null;
  schedule?: unknown;
  variables?: Record<string, string> | null;
  workflowHint?: string | null;
  workflowId?: string | null;
  replaceRecipients?: boolean;
  addRecipients?: boolean;
  resetDraft?: boolean;
  assistantReply?: string;
};

type LlmContext = {
  templates: Array<{ id: string; name: string; description: string }>;
  leads: Array<{ id: string; contactName: string; companyName: string; contactEmail: string }>;
  workflows: Array<{ id: string; templateId: string; status: string }>;
  /** Who we have already emailed and when — the assistant's long-term memory. */
  mailMemory: Awaited<ReturnType<typeof buildMailMemory>>;
};

async function buildLlmContext(userId: string): Promise<LlmContext> {
  const [templates, leads, workflows, mailMemory] = await Promise.all([
    listEmailTemplates(userId),
    CrmEntities.leads
      .find({ userId })
      .sort({ _order: -1 })
      .limit(LEAD_CONTEXT_LIMIT)
      .select('id contactName companyName contactEmail')
      .lean(),
    listWorkflows(userId),
    // History must never take the chat down with it — an empty memory is degraded, not broken.
    buildMailMemory(userId).catch(() => []),
  ]);

  return {
    mailMemory,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: String(t.description ?? ''),
    })),
    leads: leads.map((lead) => ({
      id: String(lead.id ?? ''),
      contactName: String(lead.contactName ?? ''),
      companyName: String(lead.companyName ?? ''),
      contactEmail: String(lead.contactEmail ?? ''),
    })),
    workflows: workflows.map((wf) => ({
      id: wf.id,
      templateId: wf.templateId,
      status: wf.status,
    })),
  };
}

function buildSystemPrompt(ctx: LlmContext, draft: ConversationDraft): string {
  return [
    'You extract structured data from a message about scheduling an email. Return JSON only.',
    'You do NOT control the conversation. Never claim an email was sent, scheduled, paused or cancelled.',
    'Never ask for a timezone — the workspace default applies.',
    'Never invent template ids, lead ids or times. Use only the provided lists.',
    'If a field is not mentioned in the message, omit it — do not repeat the current draft back.',
    'Set replaceRecipients true only if the user swaps recipients ("instead", "forget X").',
    'Set addRecipients true if the user adds someone ("also add Priya").',
    'Set resetDraft true only if the user explicitly starts over.',
    'Fields: action (create|update|pause|resume|cancel|list), templateHint?, templateId?, recipientHints?, recipientIds?, schedule?, variables?, workflowHint?, workflowId?, replaceRecipients?, addRecipients?, resetDraft?, assistantReply (one short sentence, optional).',
    'schedule is {frequency:"once", runAt:ISO} or {frequency:"daily"|"weekly"|"monthly", time:"HH:mm", dayOfWeek?:1-7, dayOfMonth?:1-31}.',
    `Current draft: ${JSON.stringify({
      state: draft.state,
      templateId: draft.templateId ?? null,
      templateHint: draft.templateHint ?? null,
      recipientIds: draft.recipientIds,
      recipientHints: draft.recipientHints,
      schedule: draft.schedule ?? null,
      variables: draft.variables,
    })}`,
    `Templates: ${JSON.stringify(ctx.templates.map((t) => ({ id: t.id, name: t.name })))}`,
    `Leads: ${JSON.stringify(ctx.leads.map((l) => ({ id: l.id, name: l.contactName, company: l.companyName })))}`,
    `Workflows: ${JSON.stringify(ctx.workflows)}`,
    'MailHistory is past sends, for reference only. Never treat it as a request to resend.',
    `MailHistory: ${JSON.stringify(ctx.mailMemory)}`,
  ].join('\n');
}

async function interpretMessage(
  userId: string,
  text: string,
  draft: ConversationDraft,
): Promise<LlmInterpretation> {
  const { apiKey, baseUrl, model } = config.chatLlm;
  if (!apiKey) {
    throw new WorkflowError(
      'AUTH_REQUIRED',
      'The mail assistant is not configured yet. Ask an administrator to set OPENAI_API_KEY.',
      503,
    );
  }

  const ctx = await buildLlmContext(userId);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(ctx, draft) },
        { role: 'user', content: text },
      ],
    }),
  }).catch(() => null);

  if (!res || !res.ok) {
    mailLog.warn('llm.request_failed', { userId, status: res?.status });
    throw new WorkflowError('CONTRACT_INVALID', 'I did not quite catch that. Could you rephrase?');
  }

  const data = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new WorkflowError('CONTRACT_INVALID', 'I did not quite catch that. Could you rephrase?');
  }

  try {
    return JSON.parse(content) as LlmInterpretation;
  } catch {
    throw new WorkflowError('CONTRACT_INVALID', 'I did not quite catch that. Could you rephrase?');
  }
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The model can hallucinate `{frequency:'hourly'}` or `time:'9am'`; unvalidated those
 * reach computeNextRunAt and throw a 500. Drop anything parseContract would reject.
 */
export function sanitizeSchedule(raw: unknown): WorkflowSchedule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const frequency = String(s.frequency ?? '').trim().toLowerCase();

  if (frequency === 'once') {
    const runAt = String(s.runAt ?? s.oneTimeSendAt ?? '').trim();
    const dt = new Date(runAt);
    if (!runAt || Number.isNaN(dt.getTime())) return null;
    return { frequency: 'once', runAt: dt.toISOString() };
  }

  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') return null;

  let time = String(s.time ?? '').trim();
  if (/^\d:\d{2}$/.test(time)) time = `0${time}`;
  if (!HHMM_RE.test(time)) return null;

  const dayOfWeek = s.dayOfWeek == null ? undefined : Number(s.dayOfWeek);
  if (frequency === 'weekly' && !(Number.isInteger(dayOfWeek) && dayOfWeek! >= 1 && dayOfWeek! <= 7)) {
    return null;
  }
  const dayOfMonth = s.dayOfMonth == null ? undefined : Number(s.dayOfMonth);
  if (frequency === 'monthly' && !(Number.isInteger(dayOfMonth) && dayOfMonth! >= 1 && dayOfMonth! <= 31)) {
    return null;
  }

  const endDate = s.endDate == null ? undefined : String(s.endDate).trim();
  const maxRuns = s.maxRuns == null ? undefined : Number(s.maxRuns);

  return {
    frequency: frequency as WorkflowSchedule['frequency'],
    time,
    ...(frequency === 'weekly' ? { dayOfWeek } : {}),
    ...(frequency === 'monthly' ? { dayOfMonth } : {}),
    ...(endDate && YMD_RE.test(endDate) ? { endDate } : {}),
    ...(Number.isInteger(maxRuns) && maxRuns! >= 1 ? { maxRuns } : {}),
  };
}

/**
 * Fold extracted data into the draft. Deliberately does NOT touch `state` — transitions
 * are owned by the caller via the chat-draft transition helpers.
 */
export function mergeInterpretation(
  draft: ConversationDraft,
  raw: LlmInterpretation,
  opts: { allowActionChange: boolean; deterministicSchedule?: WorkflowSchedule | null } = {
    allowActionChange: true,
  },
): ConversationDraft {
  // Captured before any reset: decides whether this turn retires the shortlist.
  const choiceField = draft.pendingChoices?.[0]?.field;

  if (raw.resetDraft) {
    const kept = emptyDraft();
    kept.state = 'collecting_create';
    draft = kept;
  }

  if (opts.allowActionChange && raw.action && raw.action !== 'update') {
    draft.action = raw.action;
  }

  if (raw.templateId) draft.templateId = String(raw.templateId);
  else if (raw.templateHint) draft.templateHint = String(raw.templateHint);

  if (opts.allowActionChange) {
    if (raw.workflowId) draft.workflowId = String(raw.workflowId);
    if (raw.workflowHint) draft.workflowHint = String(raw.workflowHint);
  }

  if (raw.replaceRecipients) {
    draft.recipientIds = [];
    draft.recipientHints = [];
  }

  if (Array.isArray(raw.recipientIds) && raw.recipientIds.length) {
    const ids = raw.recipientIds.map(String);
    draft.recipientIds = raw.addRecipients
      ? [...new Set([...draft.recipientIds, ...ids])]
      : ids;
    if (!raw.addRecipients) draft.recipientHints = [];
  } else if (Array.isArray(raw.recipientHints) && raw.recipientHints.length) {
    const hints = raw.recipientHints.map(String).filter(Boolean);
    draft.recipientHints = raw.addRecipients
      ? [...new Set([...draft.recipientHints, ...hints])]
      : hints;
  }

  // A deterministically parsed time always beats whatever the model produced.
  const schedule = opts.deterministicSchedule ?? sanitizeSchedule(raw.schedule);
  if (schedule) {
    draft.schedule = schedule;
    draft.executionMode = executionModeOf(schedule);
  }

  if (raw.variables && typeof raw.variables === 'object') {
    draft.variables = { ...draft.variables, ...raw.variables };
  }

  // A shortlist outlives an unrelated turn — the user may still answer "the second one"
  // next. Only a turn that actually resolved that field retires it.
  const answeredChoice =
    choiceField === 'templateId'
      ? Boolean(raw.templateId)
      : Boolean(raw.recipientIds?.length) || raw.replaceRecipients === true;
  if (choiceField && answeredChoice) draft.pendingChoices = undefined;

  return refreshDraftSteps(draft);
}

// ---------------------------------------------------------------------------
// Template & recipient resolution
// ---------------------------------------------------------------------------

type TemplateRecord = { id: string; name: string; description: string };

/** Templates alone — the full LLM context also scans mail history, which these callers ignore. */
async function templateRecords(userId: string): Promise<TemplateRecord[]> {
  const templates = await listEmailTemplates(userId);
  return templates.map((t) => ({ id: t.id, name: t.name, description: String(t.description ?? '') }));
}

function parseTemplateNumber(text: string): number | null {
  const t = normalize(text);
  const exact = t.match(/^(?:number|#|option|pick)?\s*(\d+)$/);
  if (exact) return Number.parseInt(exact[1], 10);
  const inline = t.match(/\bnumber\s+(\d+)\b/);
  return inline ? Number.parseInt(inline[1], 10) : null;
}

function scoreTemplateMatch(template: TemplateRecord, query: string): number {
  const stripped = normalize(query.replace(/\btemplates?\b/g, ' ')).trim();
  const q = stripped || normalize(query);
  if (!q) return 0;
  const name = normalize(template.name);
  let score = scoreMatch(`${template.name} ${template.description}`, q);
  if (name.startsWith(q) || name === q) score += 15;
  if (!name.startsWith(q) && name.endsWith(q) && name.length > q.length + 4) score -= 10;
  return score;
}

export function matchTemplatesFromText(
  text: string,
  templates: TemplateRecord[],
): { kind: 'single'; id: string; name: string } | { kind: 'choices'; choices: DraftChoice[] } | { kind: 'none' } {
  const num = parseTemplateNumber(text);
  if (num !== null && num >= 1 && num <= templates.length) {
    const t = templates[num - 1];
    return { kind: 'single', id: t.id, name: t.name };
  }

  const scored = templates
    .map((t) => ({ t, score: scoreTemplateMatch(t, text) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) return { kind: 'single', id: scored[0].t.id, name: scored[0].t.name };
  if (scored.length > 1 && scored[0].score > scored[1].score + 10) {
    return { kind: 'single', id: scored[0].t.id, name: scored[0].t.name };
  }
  if (scored.length > 1) {
    return {
      kind: 'choices',
      choices: scored.slice(0, 5).map(({ t }) => ({
        id: `tpl:${t.id}`,
        label: t.name,
        sublabel: t.description || undefined,
        field: 'templateId' as const,
        value: t.id,
      })),
    };
  }
  return { kind: 'none' };
}

function scoreLead(
  lead: { contactName: string; companyName: string; contactEmail: string },
  hint: string,
): number {
  const emailScore = lead.contactEmail && normalize(lead.contactEmail) === normalize(hint) ? 100 : 0;
  return Math.max(
    emailScore,
    scoreMatch(lead.contactName, hint),
    scoreMatch(lead.companyName, hint),
  );
}

export function matchLeadsFromHint(
  leads: LlmContext['leads'],
  hint: string,
): { kind: 'single'; id: string } | { kind: 'choices'; choices: DraftChoice[] } | { kind: 'none' } {
  const scored = leads
    .map((l) => ({ l, score: scoreLead(l, hint) }))
    .filter((x) => x.score >= 50)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { kind: 'none' };
  if (scored.length === 1) return { kind: 'single', id: scored[0].l.id };
  // A clear winner is fine; otherwise the user must choose — never pick arbitrarily.
  if (scored[0].score === 100 && scored[1].score < 100) return { kind: 'single', id: scored[0].l.id };
  return {
    kind: 'choices',
    choices: scored.slice(0, 5).map(({ l }) => ({
      id: `lead:${l.id}`,
      label: l.contactName || l.contactEmail,
      sublabel: [l.companyName, l.contactEmail].filter(Boolean).join(' · ') || undefined,
      field: 'recipientId' as const,
      value: l.id,
    })),
  };
}

function formatTemplateList(templates: TemplateRecord[]): string {
  const lines = templates.map(
    (t, i) => `${i + 1}. **${t.name}**${t.description ? ` — ${t.description}` : ''}`,
  );
  return `We have ${templates.length} template${templates.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nPick one by name or number.`;
}

type ResolveResult = { draft: ConversationDraft; autoTemplateName?: string };

/** Resolve hints into ids. Runs on every turn so later additions are never dropped. */
async function resolveDraft(userId: string, draft: ConversationDraft): Promise<ResolveResult> {
  const ctx = await buildLlmContext(userId);
  let autoTemplateName: string | undefined;

  if (!draft.templateId && draft.templateHint) {
    const match = matchTemplatesFromText(draft.templateHint, ctx.templates);
    if (match.kind === 'single') {
      draft.templateId = match.id;
      autoTemplateName = match.name;
      draft.templateHint = undefined;
    } else if (match.kind === 'choices') {
      draft.pendingChoices = match.choices;
      return { draft, autoTemplateName };
    }
  }

  const hints = draft.recipientHints.filter(Boolean);
  if (hints.length) {
    const unresolved: string[] = [];
    for (const hint of hints) {
      const match = matchLeadsFromHint(ctx.leads, hint);
      if (match.kind === 'single') {
        if (!draft.recipientIds.includes(match.id)) draft.recipientIds.push(match.id);
        continue;
      }
      if (match.kind === 'choices') {
        draft.pendingChoices = match.choices;
        draft.recipientHints = hints.filter((h) => h !== hint);
        return { draft, autoTemplateName };
      }
      unresolved.push(hint);
    }
    draft.recipientHints = unresolved;
  }

  return { draft, autoTemplateName };
}

/** True while the field an outstanding shortlist belongs to is still unanswered. */
export function choiceFieldStillOpen(draft: ConversationDraft): boolean {
  const field = draft.pendingChoices?.[0]?.field;
  if (!field) return false;
  return field === 'templateId' ? !draft.templateId : !draft.recipientIds.length;
}

function applyChoice(draft: ConversationDraft, choice: DraftChoice): ConversationDraft {
  if (choice.field === 'templateId') {
    draft.templateId = choice.value;
    draft.templateHint = undefined;
  } else if (!draft.recipientIds.includes(choice.value)) {
    draft.recipientIds = [...draft.recipientIds, choice.value];
  }
  draft.pendingChoices = undefined;
  return refreshDraftSteps(draft);
}

// ---------------------------------------------------------------------------
// Questions & previews
// ---------------------------------------------------------------------------

function nextMissingField(
  draft: ConversationDraft,
  variableNamesMissing?: string[] | null,
): MissingField | null {
  return computeMissingFields(draft, variableNamesMissing)[0] ?? null;
}

type AskContext = {
  /** 1 on the first ask, incrementing while the same field stays unanswered. */
  count: number;
  /** The hint the user gave that we could not resolve, if any. */
  unresolvedHint?: string;
  variableNames?: string[];
};

/**
 * The blocking question, escalating with each repeat. Tier 1 is the plain question; tier 2
 * says what is actually blocking; tier 3 adds a way out. Never the identical sentence twice
 * in a row — that repetition is what made the assistant feel stuck.
 */
function questionFor(field: MissingField, ctx: AskContext = { count: 1 }): string {
  const { count, unresolvedHint } = ctx;

  if (field === 'recipients') {
    if (count <= 1) return 'Who should receive this email?';
    const blocked = unresolvedHint
      ? `I couldn't find a CRM contact matching "${unresolvedHint}".`
      : 'I still need a recipient.';
    const out = count >= 3 ? ' You can also ask me to list your contacts.' : '';
    return `${blocked}${out} Give me a contact name or an email address — who should receive this email?`;
  }

  if (field === 'schedule') {
    if (count <= 1) return 'When would you like me to send it?';
    const out = count >= 3 ? " If it's a one-off, \"now\" works too." : '';
    return `I still need a time.${out} For example: "every Monday at 10 AM", "tomorrow at 3pm". When should it go out?`;
  }

  if (field === 'template') {
    if (count <= 1) return 'Which email template should I use?';
    const blocked = unresolvedHint
      ? `I couldn't find a template matching "${unresolvedHint}".`
      : 'I still need a template.';
    return `${blocked} Which email template should I use?`;
  }

  const names = ctx.variableNames ?? [];
  if (!names.length) return 'What value should I use for the template variables?';
  const list = names.map((n) => `• ${n}`).join('\n');
  const lead = count <= 1 ? 'This template needs a few details:' : 'I still need these details:';
  return `${lead}\n${list}\n\nYou can give them to me together.`;
}

/**
 * THE invariant: while collecting, whatever else a reply contains, its last line is the
 * question that is actually blocking progress. Model prose, help text and deflection
 * answers all prepend — none of them can replace the question.
 */
function withQuestion(lead: string | undefined, question: string): string {
  const prefix = lead?.trim();
  return prefix ? `${prefix}\n\n${question}` : question;
}

/**
 * What to say before re-asking when the user asked for help or deflected. A deflection on
 * recipients is the one case with a hard answer: guessing who receives outbound mail is
 * not something we do.
 */
function asideFor(field: MissingField | null, help: boolean): string {
  if (field === 'recipients') {
    return help
      ? 'You can give me a contact name or an email address, or pick from the matches I show you.'
      : "I can't guess the recipient for an outbound email — it has to be a contact from your CRM.";
  }
  if (field === 'schedule') {
    return help
      ? 'Tell me a time in plain language — "every Monday at 10 AM", "tomorrow at 3pm", or "now" for a one-off.'
      : 'I need a time from you before I can schedule anything.';
  }
  if (field === 'template') {
    return help
      ? 'Name a template, or pick one by number from the list.'
      : "If you have no preference, pick one from the list — I won't choose the wording of an outbound email for you.";
  }
  if (field === 'variables') {
    return help
      ? 'These are placeholders in the template — give me a value for each.'
      : 'These values go into the email itself, so I need them from you.';
  }
  return help
    ? 'Tell me what to send, who it goes to, and when — I will ask for anything I still need.'
    : 'Tell me what you would like to do next.';
}

async function missingVariables(
  userId: string,
  draft: ConversationDraft,
): Promise<string[] | null> {
  if (!draft.templateId) return null;
  try {
    const template = await loadTemplate(userId, draft.templateId);
    const missing = missingExtraVars(template.subject, template.body, draft.variables);
    return missing.length ? missing : null;
  } catch {
    return null;
  }
}

function draftToContract(draft: ConversationDraft, requestId: string): WorkflowCommandContractV1 {
  // parseContract is the same validation the HTTP route applies — the chat path used to
  // skip it, letting a bad schedule blow up deep inside the scheduler.
  return parseContract({
    version: 'v1',
    action: draft.action,
    templateId: draft.templateId,
    recipientIds: draft.recipientIds,
    schedule: draft.schedule,
    variables: draft.variables,
    workflowId: draft.workflowId,
    confidence: 1,
    requestId,
  });
}

export function isImmediateSchedule(schedule: WorkflowSchedule | undefined, now = Date.now()): boolean {
  if (schedule?.frequency !== 'once' || !schedule.runAt) return false;
  return new Date(schedule.runAt).getTime() <= now + 60_000;
}

function confirmLabelFor(schedule: WorkflowSchedule | undefined): string {
  if (schedule?.frequency !== 'once') return 'Confirm & Schedule';
  return isImmediateSchedule(schedule) ? 'Send Now' : 'Send Once';
}

function recipientNames(preview: PreviewSummary): string {
  if (preview.recipients.length <= 3) {
    return preview.recipients.map((r) => r.name || r.email).join(' and ');
  }
  return `${preview.recipients.length} recipients`;
}

function previewIntro(preview: PreviewSummary, connected: boolean): string {
  const mailbox = connected
    ? preview.mailbox || 'your connected Outlook account'
    : 'your Outlook account (connect to send)';
  const once = preview.contract.schedule?.frequency === 'once';
  const confirmPrompt = once
    ? (isImmediateSchedule(preview.contract.schedule) ? 'Want me to send it now?' : 'Want me to schedule this one-time send?')
    : 'Want me to schedule it?';
  return [
    "Here's what I've got:",
    '',
    `**${preview.templateName}**`,
    `To: ${recipientNames(preview)}`,
    `${preview.scheduleLabel}`,
    `From: ${mailbox}`,
    `Timezone: ${preview.timezone}`,
    preview.endLabel !== 'None' ? preview.endLabel : '',
    '',
    confirmPrompt,
  ]
    .filter(Boolean)
    .join('\n');
}

function successCreateMessage(preview: PreviewSummary, workflow: MailWorkflow): string {
  const once = preview.contract.schedule?.frequency === 'once';
  if (workflow.status === 'draft_requires_auth') {
    return once
      ? `Saved your one-time email. Connect Outlook to finish sending **${preview.templateName}**.`
      : `Saved your recurring email. Connect Outlook to finish scheduling **${preview.templateName}**.`;
  }
  if (once) {
    return isImmediateSchedule(preview.contract.schedule)
      ? `Done! **${preview.templateName}** is queued to send now — I'll record the result in the run history.`
      : `Done! **${preview.templateName}** is scheduled. ${preview.scheduleLabel}.`;
  }
  return `Done! **${preview.templateName}** is scheduled for ${preview.recipients.map((r) => r.name).join(', ')}. ${preview.scheduleLabel}.`;
}

// ---------------------------------------------------------------------------
// Management actions
// ---------------------------------------------------------------------------

function candidatesForAction(workflows: MailWorkflow[], action: WorkflowAction): MailWorkflow[] {
  return workflows.filter((wf) => {
    if (action === 'pause') return wf.status === 'active';
    if (action === 'resume') return wf.status === 'paused';
    if (action === 'cancel') return wf.status !== 'completed' && wf.status !== 'cancelled';
    return false;
  });
}

function noCandidatesMessage(action: WorkflowAction): string {
  if (action === 'pause') return 'You do not have any active recurring emails to pause.';
  if (action === 'resume') return 'You do not have any paused emails to resume.';
  return 'You do not have any scheduled emails to cancel.';
}

async function resolveWorkflowId(userId: string, draft: ConversationDraft): Promise<string> {
  if (draft.workflowId) return draft.workflowId;

  const [all, templates] = await Promise.all([listWorkflows(userId), listEmailTemplates(userId)]);
  const byTemplate = new Map(templates.map((t) => [t.id, t.name]));

  let matches = candidatesForAction(all, draft.action);
  if (!matches.length) {
    throw new WorkflowError('WORKFLOW_NOT_FOUND', noCandidatesMessage(draft.action));
  }

  if (draft.workflowHint) {
    const hint = normalize(draft.workflowHint);
    const hinted = matches.filter((wf) => scoreMatch(byTemplate.get(wf.templateId) ?? wf.templateId, hint) >= 40);
    if (hinted.length) matches = hinted;
  }

  if (matches.length !== 1) throw new WorkflowError('AMBIGUOUS_WORKFLOW', 'multiple workflows match');
  return matches[0].id;
}

function statusLabel(status: MailWorkflow['status']): string {
  if (status === 'active') return 'Active';
  if (status === 'paused') return 'Paused';
  if (status === 'paused_auth_required') return 'Paused — Outlook needs reconnecting';
  if (status === 'pending_confirm') return 'Waiting for your confirmation';
  if (status === 'draft_requires_auth') return 'Saved — connect Outlook to start';
  return status.replace(/_/g, ' ');
}

async function formatWorkflowList(userId: string): Promise<string> {
  const [workflows, templates] = await Promise.all([
    listWorkflows(userId),
    listEmailTemplates(userId),
  ]);
  const names = new Map(templates.map((t) => [t.id, t.name]));
  const active = workflows.filter((wf) => wf.status !== 'completed' && wf.status !== 'cancelled');

  if (!active.length) {
    return 'You do not have any scheduled emails yet. Tell me what you would like to schedule.';
  }

  const lines = active.map((wf) => {
    const label = names.get(wf.templateId) ?? wf.templateId;
    const sched = scheduleLabel(modelScheduleToContract(wf.schedule), wf.timezone);
    return `**${label}**\n→ ${wf.recipientIds.length} recipient${wf.recipientIds.length === 1 ? '' : 's'}\n→ ${sched}\n→ ${statusLabel(wf.status)}`;
  });

  return `You currently have ${active.length} scheduled email${active.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`;
}

async function handleManagementAction(
  userId: string,
  draft: ConversationDraft,
  requestId: string,
  assistantReply?: string,
): Promise<ChatMessageResult> {
  if (draft.action === 'list') {
    // Listing is a read — it must never destroy an in-progress create draft.
    const [message, workflows] = await Promise.all([
      formatWorkflowList(userId),
      listWorkflows(userId),
    ]);
    return { kind: 'assistant_message', message, workflows };
  }

  let workflowId: string;
  try {
    workflowId = await resolveWorkflowId(userId, draft);
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'WORKFLOW_NOT_FOUND') {
      await clearDraft(userId);
      return { kind: 'assistant_message', message: err.message };
    }
    if (err instanceof WorkflowError && err.code === 'AMBIGUOUS_WORKFLOW') {
      const [workflows, templates] = await Promise.all([
        listWorkflows(userId),
        listEmailTemplates(userId),
      ]);
      const names = new Map(templates.map((t) => [t.id, t.name]));
      const matches = candidatesForAction(workflows, draft.action);
      if (!matches.length) {
        await clearDraft(userId);
        return { kind: 'assistant_message', message: noCandidatesMessage(draft.action) };
      }
      await saveDraft(userId, draft);
      return {
        kind: 'assistant_message',
        message: 'Which scheduled email did you mean?',
        choices: matches.slice(0, 6).map((wf) => ({
          id: `wf:${wf.id}`,
          label: names.get(wf.templateId) ?? wf.templateId,
          sublabel: scheduleLabel(modelScheduleToContract(wf.schedule), wf.timezone),
        })),
      };
    }
    throw err;
  }

  const action = draft.action;
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    await clearDraft(userId);
    return {
      kind: 'assistant_message',
      message:
        "I can't edit an existing scheduled email yet. Cancel it and I'll set up a new one with the changes.",
      suggestions: ['Cancel it', 'Show my scheduled emails'],
    };
  }

  const wf = await getWorkflow(userId, workflowId);
  const template = await loadTemplate(userId, wf.templateId);
  const sched = scheduleLabel(modelScheduleToContract(wf.schedule), wf.timezone);

  await saveDraft(userId, toAwaitingManagementConfirmation(action, workflowId, requestId));

  const messages: Record<typeof action, string> = {
    cancel: `Sure. I'll cancel **${template.name}** (${sched}). Are you sure?`,
    pause: `Sure. I'll pause **${template.name}** sent ${sched.toLowerCase()}. Are you sure?`,
    resume: `**${template.name}** is paused (${sched}). Resume it?`,
  };
  const labels: Record<typeof action, string> = {
    cancel: 'Cancel workflow',
    pause: 'Pause',
    resume: 'Resume',
  };

  return {
    kind: 'assistant_message',
    message: assistantReply?.trim() || messages[action],
    confirmAction: { type: action, workflowId, label: labels[action] },
  };
}

// ---------------------------------------------------------------------------
// Create flow
// ---------------------------------------------------------------------------

async function handleCreateDraft(
  userId: string,
  draft: ConversationDraft,
  requestId: string,
  assistantReply?: string,
  autoTemplateName?: string,
): Promise<ChatMessageResult> {
  // A shortlist now survives unrelated turns, so it can outlive its own question — the
  // user may have answered by naming the contact outright. Retire it once the field is set.
  if (draft.pendingChoices?.length && !choiceFieldStillOpen(draft)) {
    draft.pendingChoices = undefined;
  }

  if (draft.pendingChoices?.length) {
    const first = draft.pendingChoices[0];
    await saveDraft(userId, draft);
    return {
      kind: 'assistant_message',
      message:
        first.field === 'templateId'
          ? 'I found a few matching templates. Which one should I use? Reply with the name or the number.'
          : 'I found more than one match. Which one did you mean? Reply with the name or the number.',
      choices: draft.pendingChoices.map(({ id, label, sublabel }) => ({ id, label, sublabel })),
    };
  }

  toCollecting(draft);
  // Variables need the chosen template, so resolve them before deciding what is missing —
  // that is what lets 'variables' be a real field rather than a special case afterwards.
  const extraMissing = await missingVariables(userId, draft);
  refreshDraftSteps(draft, extraMissing);

  const missing = nextMissingField(draft, extraMissing);
  if (missing) {
    const count = noteAsked(draft, missing);
    await saveDraft(userId, draft);

    const lead = autoTemplateName
      ? `I found the **${autoTemplateName}** template — I'll use that.`
      : assistantReply;

    // Once we have had to ask twice, show the list instead of naming the field again.
    // formatTemplateList already ends with its own prompt, so the invariant still holds.
    const question =
      missing === 'template' && count >= 2
        ? formatTemplateList(await templateRecords(userId))
        : questionFor(missing, {
            count,
            unresolvedHint:
              missing === 'recipients'
                ? draft.recipientHints[0]
                : missing === 'template'
                  ? draft.templateHint
                  : undefined,
            variableNames: extraMissing ?? undefined,
          });

    return { kind: 'assistant_message', message: withQuestion(lead, question) };
  }

  clearAsked(draft);

  // `missing` is empty exactly when the draft is complete, so the old
  // "hints resolved to nothing" branch that used to live here is now unreachable.
  if (!draftIsComplete(draft)) {
    await saveDraft(userId, draft);
    return { kind: 'assistant_message', message: questionFor('schedule') };
  }

  const confirmRequestId = draft.confirmRequestId ?? randomUUID();
  const contract = draftToContract(draft, confirmRequestId);
  const preflight = await inboxPreflight(userId);
  const preview = await buildDraftPreview(userId, contract);

  toAwaitingCreateConfirmation(draft, confirmRequestId);
  refreshDraftSteps(draft, extraMissing);
  await saveDraft(userId, draft);

  const confirmAction = { type: 'schedule' as const, label: confirmLabelFor(draft.schedule) };

  if (!preflight.connected) {
    return {
      kind: 'assistant_message',
      message:
        "I have everything I need, but your Outlook account is not connected yet.\n\nConnect your Outlook inbox and then confirm — I'll keep this ready.",
      preview,
      connectInbox: true,
      confirmAction,
    };
  }

  let message = previewIntro(preview, true);
  if (autoTemplateName) {
    message = `I found the **${autoTemplateName}** template — I'll use that.\n\n${message}`;
  } else if (assistantReply?.trim()) {
    message = `${assistantReply.trim()}\n\n${message}`;
  }

  return { kind: 'assistant_message', message, preview, confirmAction };
}

/**
 * THE canonical confirmation path. The UI button and a natural-language "yes" both land
 * here, so they cannot diverge, and the draft's stored requestId makes it idempotent.
 */
/**
 * Which confirmation the caller believes it is confirming. A button carries this; a typed
 * "yes" does not, and does not need to — it means "the thing at the bottom of the chat".
 */
export type ConfirmTarget = {
  /** The `contract.requestId` of the preview card that was clicked. */
  confirmToken?: string;
  /** The workflow a pause/resume/cancel card was rendered for. */
  workflowId?: string;
};

/** True when a card is confirming something other than what the draft now holds. */
export function confirmTargetIsStale(
  draft: ConversationDraft,
  target: ConfirmTarget | undefined,
): boolean {
  if (!target) return false;
  if (target.confirmToken && draft.confirmRequestId && target.confirmToken !== draft.confirmRequestId) {
    return true;
  }
  return Boolean(
    target.workflowId && draft.confirmationWorkflowId && target.workflowId !== draft.confirmationWorkflowId,
  );
}

export async function confirmPendingChat(
  userId: string,
  fallbackRequestId: string,
  target?: ConfirmTarget,
): Promise<ChatMessageResult> {
  const draft = await getDraft(userId);

  if (draft.state !== 'awaiting_confirmation' || !draft.awaitingConfirmation) {
    return {
      kind: 'assistant_message',
      message: "There's nothing waiting for confirmation right now. Tell me what you'd like to send.",
    };
  }

  // Every card ever rendered stays clickable, and the whole history rehydrates on reload.
  // Without this check an old card confirms whatever the draft holds NOW — you click a
  // card showing one recipient and time, and a different send goes out.
  if (confirmTargetIsStale(draft, target)) {
    return {
      kind: 'assistant_message',
      message:
        "That card is out of date — the draft changed after it was shown, so I haven't acted on it. Use the most recent card, or tell me what you'd like to do.",
    };
  }

  const requestId = draft.confirmRequestId ?? fallbackRequestId;
  const kind = draft.awaitingConfirmation;

  if (kind !== 'create') {
    const workflowId = draft.confirmationWorkflowId;
    if (!workflowId) {
      await clearDraft(userId);
      return {
        kind: 'assistant_message',
        message: 'That confirmation expired. Please run the command again.',
      };
    }
    const workflow =
      kind === 'pause' ? await pauseWorkflow(userId, workflowId, requestId)
      : kind === 'resume' ? await resumeWorkflow(userId, workflowId, requestId)
      : await cancelWorkflow(userId, workflowId, requestId);
    await clearDraft(userId);
    const template = await loadTemplate(userId, workflow.templateId);
    const verb = kind === 'pause' ? 'Paused' : kind === 'resume' ? 'Resumed' : 'Cancelled';
    return {
      kind: 'assistant_message',
      message: `${verb} **${template.name}**.`,
      workflows: [workflow],
    };
  }

  if (!draftIsComplete(draft)) {
    toEditing(draft);
    await saveDraft(userId, draft);
    return {
      kind: 'assistant_message',
      message: "Something is missing from that draft — let's fill it in before I send anything.",
    };
  }

  const contract = draftToContract(draft, requestId);
  const result = await createWorkflow(userId, contract, { confirmed: true });
  await clearDraft(userId);

  if ('kind' in result && result.kind === 'preview_summary') {
    return {
      kind: 'assistant_message',
      message: previewIntro(result, true),
      preview: result,
      confirmAction: { type: 'schedule', label: confirmLabelFor(contract.schedule) },
    };
  }

  const workflow = result as MailWorkflow;
  const preview = await buildDraftPreview(userId, contract);
  mailLog.info('chat.create_confirmed', {
    workspaceId: userId,
    userId,
    workflowId: workflow.id,
    requestId,
  });
  return {
    kind: 'assistant_message',
    message: successCreateMessage(preview, workflow),
    workflows: [workflow],
  };
}

// ---------------------------------------------------------------------------
// Confirmation-state handling for free text
// ---------------------------------------------------------------------------

async function handleAwaitingConfirmationText(
  userId: string,
  draft: ConversationDraft,
  text: string,
  requestId: string,
): Promise<ChatMessageResult | null> {
  if (draft.state !== 'awaiting_confirmation') return null;

  if (isNaturalCancelReply(text)) {
    await clearDraft(userId);
    return { kind: 'assistant_message', message: 'Okay — I did not make any changes.' };
  }

  // Confirmation is action-specific. "send it" is a perfectly good yes for a send, and a
  // terrible one for "are you sure you want to cancel this workflow?" — it reads as the
  // opposite of what it would do. Management actions need an unambiguous yes.
  if (draft.awaitingConfirmation !== 'create') {
    if (isExplicitYes(text)) return confirmPendingChat(userId, requestId);
    const label = draft.awaitingConfirmation ?? 'this change';
    return {
      kind: 'assistant_message',
      message: `Reply with yes to confirm the ${label}, or no to leave it as it is.`,
    };
  }

  if (isNaturalConfirmReply(text)) {
    return confirmPendingChat(userId, requestId);
  }

  if (isBareEditRequest(text)) {
    toEditing(draft);
    await saveDraft(userId, draft);
    return {
      kind: 'assistant_message',
      message: 'Sure — what would you like to change?',
    };
  }

  // A question is not an edit. Answering one used to drop `awaiting_confirmation` while
  // the preview card stayed on screen and enabled, so its button then reported
  // "there's nothing waiting for confirmation". Corrections are tested first, which is
  // what keeps "make it 3pm?" an edit rather than a question.
  //
  // ponytail: this only preserves the confirmation, it does not answer the question —
  // the card above already shows recipient, schedule, template and subject. Answer from
  // the draft here if users start asking things the card does not display.
  // Help and deflections belong here too: "help" and "whatever" are not edits, and
  // silently retiring the confirmation is the worst reading of either.
  if (
    !looksLikeScheduleCorrection(text)
    && !looksLikeRecipientCorrection(text)
    && (looksLikeQuestion(text) || isHelpRequest(text) || isDeflection(text))
  ) {
    return {
      kind: 'assistant_message',
      message: withQuestion(
        pendingSummaryFor(draft),
        `${pendingPromptFor(draft)} Say yes to confirm, no to cancel, or tell me what to change.`,
      ),
    };
  }

  // Anything else is an edit that carries content. Return to collecting and let the
  // normal pipeline apply it — the message must not be thrown away.
  toEditing(draft);
  await saveDraft(userId, draft);
  return null;
}

/**
 * Restates what is pending WITHOUT depending on the card being visible. The card can be
 * scrolled far up, or — after enough turns — evicted by the session's message cap, and
 * "everything is in the card above" is useless in either case.
 */
export function pendingSummaryFor(draft: ConversationDraft): string {
  const count = draft.recipientIds.length;
  const who = count === 1 ? '1 recipient' : `${count} recipients`;
  const when = draft.schedule ? scheduleLabel(draft.schedule, workflowTimezone()) : 'no time set';
  return `Still pending: ${who}, ${when}.`;
}

/** Phrases the outstanding confirmation the way the card's own button does. */
function pendingPromptFor(draft: ConversationDraft): string {
  const schedule = draft.schedule;
  if (schedule?.frequency !== 'once') return 'Ready to schedule it?';
  return isImmediateSchedule(schedule)
    ? 'Ready to send it now?'
    : 'Ready to schedule that one-time send?';
}

async function handleCreateStepContext(
  userId: string,
  text: string,
  draft: ConversationDraft,
  requestId: string,
): Promise<ChatMessageResult | null> {
  refreshDraftSteps(draft);
  if (draft.currentStep !== 'template') return null;

  const templates = await templateRecords(userId);
  const match = matchTemplatesFromText(text, templates);

  // A confident template match beats the correction heuristics: "Weekly Digest" is the
  // name of a template, not a request to send weekly.
  if (match.kind === 'single') {
    draft.templateId = match.id;
    draft.templateHint = undefined;
    draft.pendingChoices = undefined;
    await saveDraft(userId, draft);
    const resolved = await resolveDraft(userId, draft);
    return handleCreateDraft(userId, resolved.draft, requestId, undefined, match.name);
  }

  if (looksLikeScheduleCorrection(text) || looksLikeRecipientCorrection(text)) return null;

  if (match.kind === 'choices') {
    draft.pendingChoices = match.choices;
    await saveDraft(userId, draft);
    return {
      kind: 'assistant_message',
      message: 'I found a few matching templates. Which one should I use?',
      choices: match.choices.map(({ id, label, sublabel }) => ({ id, label, sublabel })),
    };
  }

  await saveDraft(userId, draft);
  return {
    kind: 'assistant_message',
    message: `I couldn't find a matching template.\n\n${formatTemplateList(templates)}`,
  };
}

// ---------------------------------------------------------------------------
// Delivery status
// ---------------------------------------------------------------------------

function formatIsoDateTime(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toLocaleString();
}

async function buildDeliveryStatusMessage(
  userId: string,
  draft: ConversationDraft,
): Promise<AssistantMessage> {
  const workflows = await listWorkflows(userId);
  if (!workflows.length) {
    return { kind: 'assistant_message', message: 'I do not see any sent or scheduled emails yet.' };
  }

  const preferredId = draft.confirmationWorkflowId ?? draft.workflowId;
  const target = (preferredId ? workflows.find((wf) => wf.id === preferredId) : null) ?? workflows[0];
  const runs = await listRuns(userId, target.id);
  const lastRun = runs[0];

  if (lastRun?.status === 'success') {
    return {
      kind: 'assistant_message',
      message: `Yes — the last send succeeded at ${formatIsoDateTime(lastRun.scheduledAt) ?? 'the last run'}.`,
      workflows: [target],
    };
  }
  if (lastRun?.status === 'partial_success') {
    const sent = lastRun.recipients?.filter((r) => r.status === 'sent').length ?? 0;
    const total = lastRun.recipients?.length ?? 0;
    return {
      kind: 'assistant_message',
      message: `Partly — ${sent} of ${total} recipients received it. The rest failed; check the run history for details.`,
      workflows: [target],
    };
  }
  if (lastRun?.status === 'unknown') {
    return {
      kind: 'assistant_message',
      message:
        "I can't confirm that one. The send was dispatched to Outlook but I never got a definite answer back, so it may or may not have gone out. Please check your Sent Items before resending.",
      workflows: [target],
    };
  }
  if (lastRun?.status === 'failed') {
    return {
      kind: 'assistant_message',
      message: `I tried to send it at ${formatIsoDateTime(lastRun.scheduledAt) ?? 'the last run'}, but it failed (${lastRun.failureReason ?? 'send failure'}).`,
      workflows: [target],
    };
  }
  if (target.status === 'draft_requires_auth' || target.status === 'paused_auth_required') {
    return {
      kind: 'assistant_message',
      message: 'Not yet — your Outlook account needs to be reconnected before this can continue.',
      workflows: [target],
    };
  }
  if (target.status === 'pending_confirm') {
    return {
      kind: 'assistant_message',
      message: 'Not yet — it is waiting for your confirmation.',
      workflows: [target],
    };
  }
  if (target.status === 'paused') {
    return { kind: 'assistant_message', message: 'Not currently — this workflow is paused.', workflows: [target] };
  }
  if (target.nextRunAt) {
    return {
      kind: 'assistant_message',
      message: `Not yet — next send is scheduled for ${formatIsoDateTime(target.nextRunAt) ?? 'the next run window'}.`,
      workflows: [target],
    };
  }
  return {
    kind: 'assistant_message',
    message: `Current status is **${statusLabel(target.status)}**.`,
    workflows: [target],
  };
}

// ---------------------------------------------------------------------------
// Slash-command argument extraction
// ---------------------------------------------------------------------------

export function extractCreateSlashArgs(text: string): Pick<
  ConversationDraft,
  'templateHint' | 'recipientHints'
> {
  const trimmed = text.trim();
  if (!trimmed) return { recipientHints: [] };

  const toMatch = trimmed.match(/\bto\s+(.+)$/i);
  const recipientHints = toMatch?.[1]?.trim() ? [toMatch[1].trim()] : [];
  const beforeTo = (toMatch ? trimmed.slice(0, toMatch.index!) : trimmed).trim();

  let templateHint: string | undefined;
  const followUp = beforeTo.match(/\b(?:a\s+)?(follow[\s-]?ups?(?:\s+\d+)?)\b/i);
  if (followUp) {
    templateHint = followUp[1].replace(/\s+/g, ' ').trim();
  } else if (beforeTo) {
    templateHint = beforeTo
      .replace(/^(?:send|schedule)\s+(?:the\s+)?/i, '')
      .replace(/^(?:a\s+|the\s+)/i, '')
      .trim() || undefined;
  }

  return { templateHint, recipientHints };
}

function titleCaseName(name: string): string {
  return name.replace(/\b([a-z])/gi, (m) => m.toUpperCase());
}

/**
 * Deterministic acknowledgement for `/create <args>`. Always wins over the model's
 * paraphrase, which used to produce things like "I'll set up a i want for Create Follow Up".
 */
export function createSlashAckMessage(
  draft: ConversationDraft,
  recipientDisplay?: string,
): string | undefined {
  if (nextMissingField(draft) !== 'schedule') return undefined;

  const recipient = recipientDisplay ?? draft.recipientHints[0];
  if (!recipient && draft.recipientIds.length !== 1) return undefined;

  const displayName = recipient ? titleCaseName(recipient) : 'the recipient';
  const templateLabel = draft.templateHint && /follow[\s-]?up/i.test(draft.templateHint)
    ? 'follow-up'
    : draft.templateHint ?? 'recurring email';

  return `Got it — I'll set up a ${templateLabel} for ${displayName}. When should it be sent?`;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleChatMessage(
  userId: string,
  input: ChatMessageInput,
): Promise<ChatMessageResult> {
  const { text, requestId, confirm, choiceId } = input;
  const timezone = workflowTimezone();

  // ---- explicit confirm from the UI: same canonical path as a spoken "yes" ----
  if (confirm?.workflowId || confirm?.action === 'schedule') {
    // The card names the workflow it was rendered for, so a stale management card cannot
    // pause or cancel whatever happens to be pending now.
    return confirmPendingChat(userId, requestId, { workflowId: confirm.workflowId });
  }

  // ---- choice buttons ----
  if (choiceId) {
    let draft = await getDraft(userId);
    const pending = draft.pendingChoices?.find((c) => c.id === choiceId);
    if (pending) {
      draft = applyChoice(draft, pending);
      await saveDraft(userId, draft);
      const resolved = await resolveDraft(userId, draft);
      return handleCreateDraft(userId, resolved.draft, requestId, undefined, resolved.autoTemplateName);
    }
    if (choiceId.startsWith('wf:')) {
      draft.workflowId = choiceId.slice(3);
      await saveDraft(userId, draft);
      return handleManagementAction(userId, draft, requestId);
    }
    return {
      kind: 'assistant_message',
      message:
        "That option is no longer available — it belongs to an earlier conversation. Tell me what you'd like to do and we'll start from there.",
    };
  }

  // ---- slash commands: fully deterministic ----
  const slash = parseSlashCommand(text);
  if (slash) {
    if (slash.kind === 'unknown') return slashUnknownMessage(slash.command);
    if (slash.kind === 'help') return slashHelpMessage();

    if (slash.kind === 'create' || slash.kind === 'send') {
      const args = slash.arguments?.trim();
      let draft = emptyDraft();
      toCollecting(draft);
      if (slash.kind === 'send') {
        // /send seeds an immediate one-time schedule; the user can still change the time.
        draft.schedule = { frequency: 'once', runAt: new Date().toISOString() };
        draft.executionMode = 'once';
      }

      if (!args) {
        await saveDraft(userId, draft);
        return slash.kind === 'send' ? slashSendMessage() : slashCreateMessage();
      }

      const extracted = extractCreateSlashArgs(args);
      if (extracted.templateHint) draft.templateHint = extracted.templateHint;
      if (extracted.recipientHints.length) draft.recipientHints = extracted.recipientHints;

      const when = parseWhen(args, timezone);
      if (when) {
        draft.schedule = when.schedule;
        draft.executionMode = executionModeOf(when.schedule);
      }
      refreshDraftSteps(draft);

      let assistantReply: string | undefined;
      try {
        const parsed = await interpretMessage(userId, args, draft);
        draft = mergeInterpretation(draft, parsed, {
          allowActionChange: false,
          deterministicSchedule: when?.schedule ?? null,
        });
        assistantReply = parsed.assistantReply;
      } catch (err) {
        if (!(err instanceof WorkflowError) || err.code === 'AUTH_REQUIRED') throw err;
      }

      const resolved = await resolveDraft(userId, draft);
      draft = refreshDraftSteps(resolved.draft);

      // Deterministic ack beats any model paraphrase.
      const ack = createSlashAckMessage(draft, extracted.recipientHints[0]);
      if (ack) assistantReply = ack;

      return handleCreateDraft(userId, draft, requestId, assistantReply, resolved.autoTemplateName);
    }

    const mgmt = { ...emptyDraft(), action: slash.action, ...(slash.hint ? { workflowHint: slash.hint } : {}) };
    return handleManagementAction(userId, mgmt, requestId);
  }

  let draft = await getDraft(userId);

  // ---- greeting only resets a genuinely idle conversation ----
  if (isGreeting(text) && draftIsIdle(draft)) {
    await clearDraft(userId);
    return greetingMessage();
  }

  if (isDeliveryStatusQuery(text) && draft.state !== 'awaiting_confirmation') {
    return buildDeliveryStatusMessage(userId, draft);
  }

  // ---- confirmation state ----
  const pendingResult = await handleAwaitingConfirmationText(userId, draft, text, requestId);
  if (pendingResult) return pendingResult;
  draft = await getDraft(userId);

  const inCreateFlow = isActiveCreateFlow(draft) || draft.action === 'create';

  // ---- picking from an outstanding shortlist, ahead of everything ----
  // Must beat parseWhen: while "which one did you mean?" is open, a bare "2" is a
  // selection, not two o'clock.
  if (draft.pendingChoices?.length) {
    const picked = parseChoiceOrdinal(text, draft.pendingChoices.length);
    if (picked) {
      draft = applyChoice(draft, draft.pendingChoices[picked - 1]);
      await saveDraft(userId, draft);
      const resolved = await resolveDraft(userId, draft);
      return handleCreateDraft(userId, resolved.draft, requestId, undefined, resolved.autoTemplateName);
    }
  }

  // ---- read-only questions never destroy the draft ----
  if (inCreateFlow && isTemplateListQuery(text)) {
    const templates = await templateRecords(userId);
    await saveDraft(userId, draft);
    const pending = nextMissingField(draft);
    return {
      kind: 'assistant_message',
      message: pending
        ? withQuestion(formatTemplateList(templates), questionFor(pending, { count: 1 }))
        : formatTemplateList(templates),
    };
  }

  // ---- help and deflections answer in place, then re-ask ----
  // Neither is an answer, but neither is nonsense either. handleCreateDraft appends the
  // blocking question, so the flow survives without a branch per phrase.
  // With nothing collected there is no flow to preserve — that is just the welcome.
  if (isHelpRequest(text) && draftIsIdle(draft)) {
    return greetingMessage();
  }
  if (inCreateFlow && draftHasAnyInput(draft) && (isHelpRequest(text) || isDeflection(text))) {
    const aside = asideFor(nextMissingField(draft), isHelpRequest(text));
    return handleCreateDraft(userId, draft, requestId, aside);
  }

  // ---- deterministic time parsing, ahead of the model ----
  const when = parseWhen(text, timezone);
  if (when && draft.action === 'create') {
    // "send it now" with nothing collected must NOT send — it just records the intent.
    draft.schedule = when.schedule;
    draft.executionMode = executionModeOf(when.schedule);
    toCollecting(draft);
    await saveDraft(userId, draft);
  }

  // A bare "send it now" with an empty draft: say what is missing instead of sending.
  if (isImmediatePhrase(text) && !draftHasAnyInput(draft)) {
    await saveDraft(userId, draft);
    return {
      kind: 'assistant_message',
      message:
        "Happy to send it right away — I just need to know which template to use and who it's going to.",
    };
  }

  if (needsCreateStepRouting(draft)) {
    const contextResult = await handleCreateStepContext(userId, text, draft, requestId);
    if (contextResult) return contextResult;
  }

  let assistantReply: string | undefined;
  try {
    const parsed = await interpretMessage(userId, text, draft);
    // The model may not change the action while a create flow is in progress unless the
    // user actually used a management verb — this is what stopped the update/list loops.
    const allowActionChange = !inCreateFlow || hasExplicitManagementIntent(text);
    draft = mergeInterpretation(draft, parsed, {
      allowActionChange,
      deterministicSchedule: when?.schedule ?? null,
    });
    assistantReply = parsed.assistantReply;

    if (!allowActionChange) draft.action = 'create';
    if (draft.action === 'update') {
      // There is no edit-in-place flow; never route `update` into workflow disambiguation.
      if (inCreateFlow) {
        draft.action = 'create';
        draft.workflowHint = undefined;
        draft.workflowId = undefined;
      } else {
        await clearDraft(userId);
        return {
          kind: 'assistant_message',
          message:
            "I can't change an existing scheduled email yet. Cancel it and I'll set up a new one with your changes.",
          suggestions: ['Cancel it', 'Show my scheduled emails'],
        };
      }
    }
  } catch (err) {
    if (err instanceof WorkflowError) {
      if (err.code === 'AUTH_REQUIRED') throw err;
      // A model hiccup must not eject the user from a half-collected draft. Re-ask the
      // field we were already waiting on instead of restating the top-level menu.
      if (draft.action === 'create' && nextMissingField(draft)) {
        return handleCreateDraft(userId, draft, requestId, "Sorry — I didn't catch that.");
      }
      return {
        kind: 'assistant_message',
        message: err.message.includes('rephrase')
          ? err.message
          : 'I did not quite catch that. Tell me what you would like to schedule, send once, pause, or cancel.',
      };
    }
    throw err;
  }

  if (draft.action !== 'create') {
    return handleManagementAction(userId, draft, requestId, assistantReply);
  }

  const resolved = await resolveDraft(userId, draft);
  draft = refreshDraftSteps(resolved.draft);
  return handleCreateDraft(userId, draft, requestId, assistantReply, resolved.autoTemplateName);
}

/** Called when the user confirms the preview from the UI card. */
export async function finalizeCreateFromDraft(
  userId: string,
  requestId: string,
): Promise<ChatMessageResult> {
  return confirmPendingChat(userId, requestId);
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('chat-parser.ts')) {
  // --- greeting must not swallow real answers ---
  for (const word of ['yes', 'yep', 'no', 'ok', 'now', 'Raj', 'Bob', '2', '9am']) {
    assert.equal(isGreeting(word), false, `${word} must not be a greeting`);
  }
  assert.equal(isGreeting('hey'), true);
  assert.equal(isGreeting('Hello!'), true);
  assert.equal(isGreeting('good morning'), true);

  // --- confirm/cancel are whole-message matches ---
  assert.equal(isNaturalConfirmReply('yes'), true);
  assert.equal(isNaturalConfirmReply('ok please'), true);
  assert.equal(isNaturalConfirmReply('sure'), true);
  assert.equal(isNaturalConfirmReply('go ahead'), true);
  assert.equal(isNaturalConfirmReply('send it'), true);
  assert.equal(isNaturalConfirmReply('send it to Rahul instead'), false);
  assert.equal(isNaturalCancelReply('no'), true);
  assert.equal(isNaturalCancelReply('no, use the other template'), false);

  // --- edit keeps the user's words ---
  assert.equal(isBareEditRequest('change it'), true);
  assert.equal(isBareEditRequest('edit'), true);
  assert.equal(isBareEditRequest('Actually, make it 3pm'), false);

  // --- "did it actually send?" survives typos and short forms ---
  for (const q of [
    'did you send it',
    'did you sned it ?',
    'did you send it?',
    'has it been sent',
    'was it sent',
    'is it sent yet',
    'sent?',
    'send status',
    'delivery status',
    'did it go out',
  ]) {
    assert.equal(isDeliveryStatusQuery(q), true, `must be a status query: ${q}`);
  }
  for (const q of [
    'send it',
    'send it to Rahul instead',
    'schedule it for 3pm',
    'yes',
    'create a new template',
  ]) {
    assert.equal(isDeliveryStatusQuery(q), false, `must not be a status query: ${q}`);
  }

  // --- action drift guard ---
  assert.equal(hasExplicitManagementIntent('make it 3pm instead'), false);
  assert.equal(hasExplicitManagementIntent('how many do we have'), false);
  assert.equal(hasExplicitManagementIntent('follow up template'), false);
  assert.equal(hasExplicitManagementIntent('pause the weekly update'), true);
  assert.equal(hasExplicitManagementIntent('show my scheduled emails'), true);

  // --- read-only queries ---
  assert.equal(isTemplateListQuery('what do we have'), true);
  assert.equal(isTemplateListQuery('how many do we have'), true);
  assert.equal(isTemplateListQuery('how many templates?'), true);
  assert.equal(isTemplateListQuery('follow up template'), false);
  assert.equal(isTemplateListQuery('how many leads do we have'), false);

  // --- hallucinated schedules are dropped before they reach the scheduler ---
  assert.equal(sanitizeSchedule({ frequency: 'hourly', time: '10:00' }), null);
  assert.equal(sanitizeSchedule({ frequency: 'daily', time: '9am' }), null);
  assert.equal(sanitizeSchedule({ frequency: 'weekly', time: '10:00' }), null);
  assert.equal(sanitizeSchedule({ frequency: 'once' }), null);
  assert.equal(sanitizeSchedule({ frequency: 'daily', time: '9:05' })?.time, '09:05');
  assert.equal(sanitizeSchedule({ frequency: 'weekly', time: '10:00', dayOfWeek: 3 })?.dayOfWeek, 3);
  assert.equal(
    sanitizeSchedule({ frequency: 'once', runAt: '2026-12-31T10:00:00Z' })?.runAt,
    '2026-12-31T10:00:00.000Z',
  );

  // --- template matching ---
  const mockTemplates: TemplateRecord[] = [
    { id: '1', name: 'Follow-up 1', description: 'follow up note' },
    { id: '2', name: 'Quotation Follow-up', description: '' },
    { id: '3', name: 'Weekly Update', description: '' },
  ];
  const followUp = matchTemplatesFromText('follow up template', mockTemplates);
  assert.equal(followUp.kind, 'single');
  if (followUp.kind === 'single') assert.equal(followUp.name, 'Follow-up 1');
  assert.equal(matchTemplatesFromText('3', mockTemplates).kind, 'single');
  assert.equal(matchTemplatesFromText('nothing like this at all', mockTemplates).kind, 'none');

  // --- recipient matching never picks arbitrarily ---
  const leads = [
    { id: 'l1', contactName: 'Prakhar Sharma', companyName: 'Acme', contactEmail: 'p@acme.com' },
    { id: 'l2', contactName: 'Prakhar Sharma', companyName: 'Globex', contactEmail: 'p@globex.com' },
    { id: 'l3', contactName: 'Priya Nair', companyName: 'Initech', contactEmail: 'priya@initech.com' },
  ];
  assert.equal(matchLeadsFromHint(leads, 'Priya').kind, 'single');
  const ambiguous = matchLeadsFromHint(leads, 'Prakhar Sharma');
  assert.equal(ambiguous.kind, 'choices', 'two identical names must prompt, not guess');
  if (ambiguous.kind === 'choices') assert.equal(ambiguous.choices.length, 2);
  assert.equal(matchLeadsFromHint(leads, 'p@globex.com').kind, 'single', 'email is an exact match');
  assert.equal(matchLeadsFromHint(leads, 'nobody here').kind, 'none');

  // --- merge never mutates state, and a deterministic time wins ---
  const md = emptyDraft();
  toCollecting(md);
  const merged = mergeInterpretation(
    md,
    { action: 'update', schedule: { frequency: 'daily', time: '99:99' } },
    { allowActionChange: false, deterministicSchedule: { frequency: 'daily', time: '14:00' } },
  );
  assert.equal(merged.action, 'create', 'action change blocked');
  assert.equal(merged.schedule?.time, '14:00', 'deterministic parse wins over the model');
  assert.equal(merged.state, 'collecting_create', 'merge must not move state');

  // recipients are appended, not replaced, when the user adds someone
  const rd = emptyDraft();
  rd.recipientIds = ['l1'];
  mergeInterpretation(rd, { recipientIds: ['l3'], addRecipients: true }, { allowActionChange: true });
  assert.deepEqual(rd.recipientIds, ['l1', 'l3'], '"also add" appends');
  const rd2 = emptyDraft();
  rd2.recipientIds = ['l1'];
  mergeInterpretation(rd2, { recipientIds: ['l3'], replaceRecipients: true }, { allowActionChange: true });
  assert.deepEqual(rd2.recipientIds, ['l3'], '"instead" replaces');

  // --- slash args ---
  const extracted = extractCreateSlashArgs('a follow up to prakhar sharma');
  assert.equal(extracted.templateHint, 'follow up');
  assert.deepEqual(extracted.recipientHints, ['prakhar sharma']);

  // Mirrors the real call site: the ack runs AFTER resolveDraft, so the recipient is a
  // resolved id and the display name comes from the raw slash args.
  const ackDraft = emptyDraft();
  ackDraft.recipientIds = ['lead-1'];
  ackDraft.templateHint = 'follow up';
  refreshDraftSteps(ackDraft);
  assert.match(createSlashAckMessage(ackDraft, 'prakhar sharma')!, /Prakhar Sharma/);
  assert.match(createSlashAckMessage(ackDraft, 'prakhar sharma')!, /When should it be sent/);

  // An unresolved hint must NOT produce an ack — the recipient is still an open question.
  const unresolvedAck = emptyDraft();
  unresolvedAck.recipientHints = ['xyzabc'];
  refreshDraftSteps(unresolvedAck);
  assert.equal(createSlashAckMessage(unresolvedAck, 'xyzabc'), undefined);

  // --- ordinal selection resolves against an outstanding shortlist ---
  for (const [input, expected] of [
    ['2', 2], ['1', 1], ['#3', 3], ['option 2', 2], ['number 2', 2],
    ['second', 2], ['the second one', 2], ['the first one', 1], ['third', 3], ['2nd', 2],
  ] as Array<[string, number]>) {
    assert.equal(parseChoiceOrdinal(input, 3), expected, `"${input}" must select ${expected}`);
  }
  assert.equal(parseChoiceOrdinal('4', 3), null, 'out of range is not a selection');
  assert.equal(parseChoiceOrdinal('prakhar', 3), null, 'a name is not an ordinal');
  assert.equal(parseChoiceOrdinal('2', 0), null, 'no shortlist, no selection');
  assert.equal(parseChoiceOrdinal('send it at 2', 3), null, 'a sentence is not an ordinal');

  // --- questions escalate instead of repeating verbatim ---
  const q1 = questionFor('recipients', { count: 1 });
  const q2 = questionFor('recipients', { count: 2, unresolvedHint: 'xyzabc' });
  const q3 = questionFor('recipients', { count: 3, unresolvedHint: 'xyzabc' });
  assert.equal(q1, 'Who should receive this email?');
  assert.notEqual(q2, q1, 'the second ask must not repeat the first verbatim');
  assert.notEqual(q3, q2, 'the third ask must not repeat the second verbatim');
  assert.match(q2, /xyzabc/, 'the second ask names what could not be resolved');
  assert.notEqual(questionFor('schedule', { count: 2 }), questionFor('schedule', { count: 1 }));
  assert.notEqual(questionFor('template', { count: 2 }), questionFor('template', { count: 1 }));
  assert.match(
    questionFor('variables', { count: 1, variableNames: ['buyer_ref', 'qty'] }),
    /buyer_ref[\s\S]*qty/,
  );

  // --- model prose prepends to the question, it never replaces it ---
  assert.equal(withQuestion('Got it.', 'When should it go out?'), 'Got it.\n\nWhen should it go out?');
  assert.equal(withQuestion(undefined, 'When should it go out?'), 'When should it go out?');
  assert.equal(withQuestion('   ', 'When should it go out?'), 'When should it go out?');
  for (const lead of ['Got it.', undefined, 'Sure thing']) {
    assert.match(
      withQuestion(lead, questionFor('recipients', { count: 1 })),
      /Who should receive this email\?$/,
      'the blocking question must always be the last thing said',
    );
  }

  // --- help and deflection are recognised without hijacking real answers ---
  for (const t of ['help', 'what can I do?', 'how does this work', 'options']) {
    assert.equal(isHelpRequest(t), true, `${t} is a help request`);
  }
  for (const t of ['you pick', 'idk', "i don't know", 'doesn’t matter', 'whatever', 'up to you']) {
    assert.equal(isDeflection(t), true, `${t} is a deflection`);
  }
  for (const t of ['Prakhar Sharma', 'every Monday at 10', 'follow up', 'help me pick a template for Raj']) {
    assert.equal(isHelpRequest(t), false, `${t} must not be swallowed as help`);
    assert.equal(isDeflection(t), false, `${t} must not be swallowed as a deflection`);
  }

  // --- correction detection needs real evidence, not a stray "at" or "add" ---
  for (const t of ['make it 3pm', 'change it to Monday at 10am', 'send it tomorrow', 'change the time']) {
    assert.equal(looksLikeScheduleCorrection(t), true, `${t} is a schedule correction`);
  }
  for (const t of ['the one at the top', 'Quotation at Best Rate', 'the template at the bottom']) {
    assert.equal(looksLikeScheduleCorrection(t), false, `${t} must not read as a schedule change`);
  }
  for (const t of ['send it to Rahul instead', 'forget Raj', 'also add Priya']) {
    assert.equal(looksLikeRecipientCorrection(t), true, `${t} is a recipient correction`);
  }
  for (const t of ['Add-on Offer', 'Value Added Services']) {
    assert.equal(looksLikeRecipientCorrection(t), false, `${t} is a template name, not a recipient change`);
  }

  // --- the reported loop: an unresolvable name must not advance the flow OR repeat ---
  {
    const d = emptyDraft();
    d.action = 'create';
    const said: string[] = [];
    // Turn 1: nothing collected. Turns 2 and 3: the user answers with a name that never
    // resolves, so recipientIds stays empty.
    for (let turn = 1; turn <= 3; turn += 1) {
      if (turn > 1) d.recipientHints = ['Prakhar Sharma'];
      const field = computeMissingFields(d)[0];
      assert.equal(field, 'recipients', 'an unresolved name must never advance to schedule');
      said.push(questionFor(field, { count: noteAsked(d, field), unresolvedHint: d.recipientHints[0] }));
    }
    assert.equal(new Set(said).size, 3, 'three asks, three different sentences');
    assert.match(said[1], /Prakhar Sharma/, 'the repeat says what it could not resolve');
    for (const line of said) assert.match(line, /\?$/, 'every ask still ends in a question');

    // Resolving it moves on, and the counter starts over for the next field.
    d.recipientIds = ['lead-1'];
    assert.equal(computeMissingFields(d)[0], 'schedule');
    assert.equal(noteAsked(d, 'schedule'), 1);
  }

  // --- a shortlist survives an unrelated turn, but retires once its field is answered ---
  const leadChoices: DraftChoice[] = [
    { id: 'lead:a', label: 'Prakhar Sharma', field: 'recipientId', value: 'a' },
    { id: 'lead:b', label: 'Prakhar Sharma', field: 'recipientId', value: 'b' },
  ];
  const kept = mergeInterpretation(
    { ...emptyDraft(), pendingChoices: leadChoices },
    { recipientHints: ['prakhar'] },
    { allowActionChange: false },
  );
  assert.equal(kept.pendingChoices?.length, 2, 'an unrelated turn must not drop the shortlist');

  const retired = mergeInterpretation(
    { ...emptyDraft(), pendingChoices: leadChoices },
    { recipientIds: ['b'] },
    { allowActionChange: false },
  );
  assert.equal(retired.pendingChoices, undefined, 'resolving the field retires the shortlist');

  const tplChoices: DraftChoice[] = [
    { id: 'tpl:1', label: 'Follow-up 1', field: 'templateId', value: 't1' },
    { id: 'tpl:2', label: 'Follow-up 2', field: 'templateId', value: 't2' },
  ];
  assert.equal(
    mergeInterpretation({ ...emptyDraft(), pendingChoices: tplChoices }, { recipientHints: ['raj'] }, { allowActionChange: false })
      .pendingChoices?.length,
    2,
    'a recipient turn must not drop a template shortlist',
  );
  assert.equal(
    mergeInterpretation({ ...emptyDraft(), pendingChoices: tplChoices }, { templateId: 't2' }, { allowActionChange: false })
      .pendingChoices,
    undefined,
  );

  // A shortlist whose field got filled another way is stale and must not be re-shown.
  assert.equal(choiceFieldStillOpen({ ...emptyDraft(), pendingChoices: leadChoices }), true);
  assert.equal(
    choiceFieldStillOpen({ ...emptyDraft(), pendingChoices: leadChoices, recipientIds: ['a'] }),
    false,
  );
  assert.equal(
    choiceFieldStillOpen({ ...emptyDraft(), pendingChoices: tplChoices, templateId: 't1' }),
    false,
  );

  // --- confirmation is action-specific ---
  assert.equal(isNaturalConfirmReply('send it'), true, 'still a yes for a send');
  assert.equal(isExplicitYes('send it'), false, 'but never a yes for a pause or cancel');
  assert.equal(isExplicitYes('send it now'), false);
  assert.equal(isExplicitYes('schedule it'), false);
  for (const t of ['yes', 'confirm', 'go ahead', 'do it', 'ok']) {
    assert.equal(isExplicitYes(t), true, `${t} is an unambiguous yes`);
  }

  // --- a question at the preview must not be mistaken for an edit ---
  // The handler tests corrections FIRST, so these must stay edits even though they end
  // in a question mark. Anything reclassified here silently retires a live confirmation.
  for (const t of [
    'make it 3pm?',
    'can you send it tomorrow?',
    'change the recipient?',
    'send it to Rahul instead?',
  ]) {
    assert.equal(
      looksLikeScheduleCorrection(t) || looksLikeRecipientCorrection(t),
      true,
      `${t} must stay an edit, not become a question`,
    );
  }

  for (const t of [
    "what's in this template?",
    'who is receiving this?',
    'what time is it set for?',
    '?',
    'did you send it?',
    'what templates do we have?',
  ]) {
    assert.equal(looksLikeQuestion(t), true, `${t} is a question`);
    assert.equal(
      looksLikeScheduleCorrection(t) || looksLikeRecipientCorrection(t),
      false,
      `${t} must not be picked up as an edit first`,
    );
  }

  // A confirm phrase wearing a question mark is still a confirm — it is matched before
  // either classifier gets a look in.
  assert.equal(isNaturalConfirmReply('send it?'), true);
  assert.equal(isNaturalConfirmReply('yes?'), true);

  for (const t of ['Prakhar Sharma', 'follow up', 'every Monday at 10']) {
    assert.equal(looksLikeQuestion(t), false, `${t} is not a question`);
  }

  // Help and deflections ride the same branch — neither may retire a live confirmation.
  for (const t of ['help', 'what can I do?', 'you pick', 'idk', 'whatever']) {
    assert.equal(
      looksLikeQuestion(t) || isHelpRequest(t) || isDeflection(t),
      true,
      `${t} must preserve the pending confirmation`,
    );
    assert.equal(
      looksLikeScheduleCorrection(t) || looksLikeRecipientCorrection(t),
      false,
      `${t} must not be treated as an edit`,
    );
  }

  // --- a card confirms the draft it was rendered for, never whatever is current ---
  const live = { ...emptyDraft(), confirmRequestId: 'token-new' };
  assert.equal(confirmTargetIsStale(live, { confirmToken: 'token-new' }), false, 'the current card confirms');
  assert.equal(confirmTargetIsStale(live, { confirmToken: 'token-old' }), true, 'an older card must not');
  // A typed "yes" carries no token and always means the current draft.
  assert.equal(confirmTargetIsStale(live, undefined), false);
  assert.equal(confirmTargetIsStale(live, {}), false);
  // A draft predating the token (or a legacy session doc) degrades to the old behaviour
  // rather than refusing every confirmation.
  assert.equal(confirmTargetIsStale(emptyDraft(), { confirmToken: 'token-old' }), false);

  // Same rule for the pause/resume/cancel card.
  const mgmtLive = { ...emptyDraft(), confirmationWorkflowId: 'wf-2' };
  assert.equal(confirmTargetIsStale(mgmtLive, { workflowId: 'wf-2' }), false);
  assert.equal(
    confirmTargetIsStale(mgmtLive, { workflowId: 'wf-1' }),
    true,
    'a stale pause card must not act on a different workflow',
  );
  assert.equal(confirmTargetIsStale(mgmtLive, { workflowId: undefined }), false);

  // --- the restate stands on its own, without the card being visible ---
  const pendingDraft = {
    ...emptyDraft(),
    recipientIds: ['lead-1', 'lead-2'],
    schedule: { frequency: 'daily' as const, time: '10:00' },
  };
  const summary = pendingSummaryFor(pendingDraft);
  assert.match(summary, /2 recipients/);
  assert.doesNotMatch(summary, /card above/, 'must not point at a card that may be gone');
  assert.match(pendingSummaryFor({ ...pendingDraft, recipientIds: ['lead-1'] }), /1 recipient\b/);
  assert.match(
    pendingSummaryFor({ ...emptyDraft(), recipientIds: ['lead-1'] }),
    /no time set/,
    'a draft with no schedule still describes itself',
  );

  // --- the restated prompt matches the card's own button ---
  assert.match(pendingPromptFor({ ...emptyDraft(), schedule: { frequency: 'daily', time: '10:00' } }), /schedule it/);
  assert.match(
    pendingPromptFor({ ...emptyDraft(), schedule: { frequency: 'once', runAt: new Date().toISOString() } }),
    /send it now/,
  );
  assert.match(
    pendingPromptFor({
      ...emptyDraft(),
      schedule: { frequency: 'once', runAt: new Date(Date.now() + 864e5).toISOString() },
    }),
    /one-time send/,
  );

  // --- confirm labels reflect once vs recurring ---
  assert.equal(confirmLabelFor({ frequency: 'daily', time: '10:00' }), 'Confirm & Schedule');
  assert.equal(confirmLabelFor({ frequency: 'once', runAt: new Date().toISOString() }), 'Send Now');
  assert.equal(
    confirmLabelFor({ frequency: 'once', runAt: new Date(Date.now() + 864e5).toISOString() }),
    'Send Once',
  );
  assert.equal(isImmediateSchedule({ frequency: 'daily', time: '10:00' }), false);

  console.log('chat-parser self-check passed');
}
