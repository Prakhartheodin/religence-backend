import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import config from '../../config.js';
import { CrmEntities } from '../../models/crm-entities.js';
import { listEmailTemplates } from '../email-templates.service.js';
import { buildMailMemory } from './mail-history.js';
import {
  executionModeOf,
  MAX_SEQUENCE_SPAN_DAYS,
  MAX_SEQUENCE_STEPS,
  MIN_STEP_GAP_MINUTES,
  parseContract,
  WorkflowError,
  type StepSpec,
  type WorkflowAction,
  type WorkflowCommandContractV1,
  type WorkflowSchedule,
} from './contract.js';
import { civilDateInZone, materializeSequence, utcFromZoned, addCivilDays } from './recurrence.js';
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
  toAwaitingUpdateConfirmation,
  toCollecting,
  toEditing,
  type ConversationDraft,
  type DraftChoice,
  type MissingField,
  type Ambiguity,
  type SequenceSpec,
  type RawStep,
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
import { isImmediatePhrase, parseTimeCorrection, parseWhen } from './chat-time.js';
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
  updateWorkflow,
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
  /\b(\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}:\d{2}|\d{1,2}\s+(?:in\s+(?:the\s+)?)?(morning|afternoon|evening)|daily|weekly|monthly|monday|tuesday|wednesday|thursday|friday|saturday|sunday|every|tomorrow|today|tonight|now|asap|noon|midnight)\b/;

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
    'For MORE THAN ONE send, schedule is {frequency:"sequence", startAt:ISO, sameDay?:boolean, steps:[{spec:{kind:"after",minutes:N,from:"previous"|"start"}}|{spec:{kind:"at",time:"HH:mm",dayOffset:N}}]}. Use it only when the user describes several sends. Set sameDay true if they scoped it to one day ("3 mails today").',
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

const SEQ_INTERVAL_RE = /\bevery\s+(?:other|second|third|\d{1,3})\s+(?:day|week|month|hour)s?\b/;
const SEQ_COUNT_RE = /\b(?:\d{1,2}|two|three|four|five|twice|thrice)\s+(?:mails?|emails?|times|sends?)\b/;
const SEQ_CHAIN_RE = /\b(?:then|after that|followed by|and then)\b/;
const SEQ_NOUN_RE = /\b(?:sequence|drip|campaign|follow[- ]?ups?)\b/;
const SEQ_ORDINAL_RE = /\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\b/g;
const CLOCK_TOKEN_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/g;
const RECURRING_MODE_QUESTION =
  'Do you want this to run continuously until you pause/stop it, or for a fixed number of sends?';

/**
 * A step marker is "one"/"another"/"next" immediately followed by a when-phrase, which is how
 * people spell a sequence out without ever naming a number: "one now, one 2 hours later, one
 * at 5". The when-phrase is what keeps ordinary prose ("one of our leads") out.
 */
const SEQ_STEP_MARKER_RE =
  /\b(?:one|another|next)\s+(?:mails?|emails?)?\s*(?=right\s+now\b|now\b|today\b|tomorrow\b|later\b|at\s+\d|in\s+\d|after\s+\d|\d{1,3}\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?)\b)/g;
/** "no one now", "any one later" — a quantifier in front means it was never a step marker. */
const SEQ_MARKER_QUANTIFIER_RE = /\b(?:no|any|some|each|every|which|that|this|only|just)\s+$/;

/**
 * The number of sends implied by repeated step markers, or null when the sentence does not
 * spell a chain out. Two markers is the floor: a lone "one now" is a single send.
 */
function parseChainMarkerCount(text: string): number | null {
  const t = normalize(text);
  let markers = 0;
  for (const m of t.matchAll(SEQ_STEP_MARKER_RE)) {
    const idx = m.index ?? 0;
    if (SEQ_MARKER_QUANTIFIER_RE.test(t.slice(Math.max(0, idx - 8), idx))) continue;
    markers++;
  }
  if (markers < 2 || markers > MAX_SEQUENCE_STEPS) return null;
  return markers;
}

/**
 * True when the message describes MORE THAN ONE send. Matches on structure rather than a
 * phrase list, because a phrase list is what let "every 2 days" fall through to the model
 * and come back as "daily at 12:00 AM".
 */
export function looksLikeSequence(text: string): boolean {
  const t = normalize(text);
  if (SEQ_INTERVAL_RE.test(t) || SEQ_COUNT_RE.test(t) || SEQ_CHAIN_RE.test(t) || SEQ_NOUN_RE.test(t)) {
    return true;
  }
  if (parseChainMarkerCount(t) != null) return true;
  const ordinals = t.match(SEQ_ORDINAL_RE) ?? [];
  if (ordinals.length >= 2) return true;
  const clocks = t.match(CLOCK_TOKEN_RE) ?? [];
  return clocks.length >= 2;
}

const WORD_COUNTS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, twice: 2, thrice: 3,
};

function parseCountToken(raw: string): number | null {
  if (!raw) return null;
  if (/^\d{1,2}$/.test(raw)) return Number.parseInt(raw, 10);
  return WORD_COUNTS[raw] ?? null;
}

function parseSequenceCount(text: string): number | null {
  const t = normalize(text);
  if (/\b(?:a few|several|some)\b/.test(t)) return null;
  if (/\bevery\s+(?:other|second|third|\d)/.test(t)) return null;
  const num = t.match(/\b(\d{1,2})\s+(?:mails?|emails?|times|sends)\b/);
  if (num) return Number.parseInt(num[1], 10);
  if (/^\d{1,2}$/.test(t.trim())) return Number.parseInt(t.trim(), 10);
  for (const [word, n] of Object.entries(WORD_COUNTS)) {
    if (new RegExp(`\\b${word}\\s+(?:mails?|emails?|times|sends)\\b`).test(t)) return n;
    if (t === word) return n;
  }
  return null;
}

function parseAdditionalSequenceCount(text: string): number | null {
  const t = normalize(text);
  const m = t.match(/\badd\s+(\d{1,2}|one|two|three|four|five|twice|thrice)\s+more\s+(?:mails?|emails?|times|sends)\b/);
  if (!m) return null;
  return parseCountToken(m[1]);
}

function recurringCadenceIntent(text: string): 'recurring' | 'clarify' | null {
  const t = normalize(text);
  const hasCadence =
    /\b(?:daily|weekly|every\s+(?:(?:other|second|third|\d{1,3})\s+)?(?:day|week)s?)\b/.test(t);
  if (!hasCadence || parseSequenceCount(t) != null) return null;

  const unsupportedGap =
    /\bevery\s+(?:other|second|third|(?:[2-9]|\d{2,3}))\s+(?:day|week)s?\b/.test(t);
  const mixesFirstSendWithCadence =
    SEQ_CHAIN_RE.test(t) || (/\bnow\b/.test(t) && /\b(?:daily|weekly|every)\b/.test(t));
  return unsupportedGap || mixesFirstSendWithCadence ? 'clarify' : 'recurring';
}

function parseIntervalGapMinutes(text: string): number | null {
  const t = normalize(text);
  const m = t.match(/\bevery\s+(?:other|second|third|(\d{1,3}))\s+(day|week|month|hour)s?\b/);
  if (!m) return null;
  const n = m[1] ? Number.parseInt(m[1], 10) : 1;
  const unit = m[2];
  if (unit === 'hour') return n * 60;
  if (unit === 'day') return n * 24 * 60;
  if (unit === 'week') return n * 7 * 24 * 60;
  if (unit === 'month') return n * 30 * 24 * 60;
  return null;
}

function isForeverSequence(text: string): boolean {
  const t = normalize(text);
  return /\b(?:forever|ongoing|indefinitely|infinite)\b/.test(t);
}

/**
 * Drop candidates that would need a day roll to stay after the previous step.
 */
export function cleanCandidates(
  candidates: string[],
  previous: Date,
  timezone: string,
): string[] {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const k = c.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);

  const prevCivil = civilDateInZone(previous, timezone);
  const y = Number(prevCivil.slice(0, 4));
  const mo = Number(prevCivil.slice(5, 7));
  const d = Number(prevCivil.slice(8, 10));

  return unique.filter((time) => {
    if (!HHMM_RE.test(time)) return false;
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(3, 5));
    const sameDay = utcFromZoned(timezone, y, mo, d, hour, minute);
    return sameDay > previous;
  });
}

function specsFromGap(count: number, gapMinutes: number, anchor: 'now' | 'after_gap'): StepSpec[] {
  const specs: StepSpec[] = [];
  if (anchor === 'now') {
    specs.push({ kind: 'after', minutes: 0, from: 'start' });
    for (let i = 1; i < count; i++) {
      specs.push({ kind: 'after', minutes: gapMinutes, from: 'previous' });
    }
  } else {
    for (let i = 0; i < count; i++) {
      specs.push({
        kind: 'after',
        minutes: gapMinutes,
        from: i === 0 ? 'start' : 'previous',
      });
    }
  }
  return specs;
}

function mergeSequenceSpec(base: SequenceSpec | undefined, patch: SequenceSpec): SequenceSpec {
  return {
    startAt: patch.startAt ?? base?.startAt,
    anchor: patch.anchor ?? base?.anchor,
    count: patch.count ?? base?.count,
    sameDay: patch.sameDay ?? base?.sameDay,
    gapMinutes: patch.gapMinutes ?? base?.gapMinutes,
    steps: patch.steps.length ? patch.steps : base?.steps ?? [],
  };
}

function extractSequenceSpecFromRaw(raw: Record<string, unknown>): SequenceSpec {
  const spec: SequenceSpec = { steps: [] };
  const startAt = String(raw.startAt ?? '').trim();
  const startAtDate = new Date(startAt);
  if (startAt && !Number.isNaN(startAtDate.getTime())) spec.startAt = startAtDate.toISOString();
  if (raw.sameDay === true) spec.sameDay = true;
  const gap = parseIntervalGapMinutes(JSON.stringify(raw));
  if (gap) spec.gapMinutes = gap;
  const count = parseSequenceCount(JSON.stringify(raw));
  if (count) spec.count = count;
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  for (const entry of rawSteps) {
    const step = (entry ?? {}) as Record<string, unknown>;
    const rawSpec = (step.spec ?? {}) as Record<string, unknown>;
    const kind = String(rawSpec.kind ?? '');
    let stepSpec: StepSpec | undefined;
    if (kind === 'after') {
      const minutes = Number(rawSpec.minutes);
      if (Number.isInteger(minutes) && minutes >= 0) {
        stepSpec = {
          kind: 'after',
          minutes,
          from: rawSpec.from === 'start' ? 'start' : 'previous',
        };
      }
    } else if (kind === 'at') {
      let time = String(rawSpec.time ?? '').trim();
      if (/^\d:\d{2}$/.test(time)) time = `0${time}`;
      const dayOffset = Number(rawSpec.dayOffset ?? 0);
      if (HHMM_RE.test(time) && Number.isInteger(dayOffset) && dayOffset >= 0) {
        stepSpec = { kind: 'at', time, dayOffset };
      }
    }
    const candidates = Array.isArray(step.candidates)
      ? step.candidates.map((c) => String(c).trim()).filter((c) => HHMM_RE.test(c) || /^\d{1,2}(:\d{2})?\s*(am|pm)$/i.test(c))
      : undefined;
    const normalizedCandidates = candidates?.map((c) => normalizeClockToken(c)).filter(Boolean) as string[] | undefined;
    spec.steps.push({
      ...(stepSpec ? { spec: stepSpec } : {}),
      ...(normalizedCandidates?.length ? { candidates: normalizedCandidates } : {}),
      ...(step.templateId ? { templateId: String(step.templateId) } : {}),
    });
  }
  return spec;
}

function normalizeClockToken(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  const m12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m12) {
    let h = Number.parseInt(m12[1], 10);
    const mi = m12[2] ? Number.parseInt(m12[2], 10) : 0;
    if (m12[3] === 'pm' && h < 12) h += 12;
    if (m12[3] === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  if (HHMM_RE.test(t)) return t;
  return null;
}

function formatClockLabel(time: string): string {
  const h = Number(time.slice(0, 2));
  const m = time.slice(3, 5);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === '00' ? `${hour} ${suffix}` : `${hour}:${m} ${suffix}`;
}

function previousInstantForStep(
  spec: SequenceSpec,
  stepIndex: number,
  timezone: string,
): Date {
  const startAt = spec.startAt ? new Date(spec.startAt) : new Date();
  if (spec.anchor === 'after_gap' && spec.gapMinutes) {
    return new Date(startAt.getTime() + spec.gapMinutes * 60_000);
  }
  if (spec.gapMinutes && spec.count && stepIndex === 0 && spec.anchor === 'now') {
    return startAt;
  }
  const prefixSpecs: StepSpec[] = [];
  for (let i = 0; i < stepIndex; i++) {
    const s = spec.steps[i]?.spec;
    if (s) prefixSpecs.push(s);
  }
  if (prefixSpecs.length) {
    const at = materializeSequence(startAt, timezone, prefixSpecs);
    return at[at.length - 1];
  }
  if (spec.gapMinutes && spec.count) {
    const anchor = spec.anchor ?? 'now';
    const gapSpecs = specsFromGap(Math.min(stepIndex + 1, spec.count), spec.gapMinutes, anchor);
    const at = materializeSequence(startAt, timezone, gapSpecs);
    return at[at.length - 1];
  }
  return startAt;
}

/**
 * The outstanding question, derived — exactly as nextMissingField derives from
 * computeMissingFields()[0].
 */
export function nextAmbiguity(draft: ConversationDraft): Ambiguity | null {
  if (draft.schedule?.frequency === 'sequence') return null;
  if (!draft.sequenceRequested && !draft.sequenceSpec) return null;
  const spec = draft.sequenceSpec ?? { steps: [] };
  const timezone = workflowTimezone();

  if (spec.count == null && (draft.sequenceRequested || spec.gapMinutes != null || spec.steps.length)) {
    return { kind: 'count' };
  }

  if (spec.gapMinutes != null && spec.count != null && spec.anchor == null) {
    return { kind: 'anchor', gapMinutes: spec.gapMinutes, count: spec.count };
  }

  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i];
    const candidates = step.candidates ?? [];
    if (candidates.length <= 1) continue;
    const prev = previousInstantForStep(spec, i, timezone);
    const clean = cleanCandidates(candidates, prev, timezone);
    if (clean.length > 1) {
      return { kind: 'stepTime', stepIndex: i, candidates: clean };
    }
  }

  if (spec.count != null && spec.count > 1 && !(spec.gapMinutes != null && spec.count != null && spec.anchor)) {
    const missingSteps = missingStepNumbers(spec.steps, spec.count);
    if (missingSteps.length) {
      return {
        kind: 'stepCountMismatch',
        parsed: spec.count - missingSteps.length,
        expected: spec.count,
        missingSteps,
      };
    }
    if (spec.steps.length !== spec.count) {
      const missing = missingStepNumbers(
        spec.steps.length < spec.count
          ? [...spec.steps, ...Array(spec.count - spec.steps.length).fill({})]
          : spec.steps.slice(0, spec.count),
        spec.count,
      );
      if (missing.length) {
        return {
          kind: 'stepCountMismatch',
          parsed: spec.count - missing.length,
          expected: spec.count,
          missingSteps: missing,
        };
      }
    }
  }

  const sameDayIdx = sameDayConflictStep(spec, timezone);
  if (sameDayIdx != null) {
    return { kind: 'sameDayConflict', stepIndex: sameDayIdx };
  }

  return null;
}

function tryMaterializeSequenceDraft(draft: ConversationDraft, timezone: string): WorkflowSchedule | null {
  const spec = draft.sequenceSpec;
  if (!spec || nextAmbiguity(draft)) return null;

  let startAt = spec.startAt ? new Date(spec.startAt) : new Date();
  if (Number.isNaN(startAt.getTime())) startAt = new Date();
  let specs: StepSpec[] = [];

  if (spec.gapMinutes != null && spec.count != null && spec.anchor) {
    specs = specsFromGap(spec.count, spec.gapMinutes, spec.anchor);
    if (spec.anchor === 'after_gap') {
      startAt = new Date(Date.now() + spec.gapMinutes * 60_000);
    }
  } else if (spec.steps.length) {
    if (spec.count != null && spec.steps.length !== spec.count) return null;
    for (const step of spec.steps) {
      if (!step.spec) return null;
      specs.push(step.spec);
    }
  } else {
    return null;
  }

  const raw: Record<string, unknown> = {
    frequency: 'sequence',
    startAt: startAt.toISOString(),
    steps: specs.map((s, i) => ({
      spec: s,
      ...(spec.steps[i]?.templateId ? { templateId: spec.steps[i].templateId } : {}),
    })),
  };
  if (spec.sameDay) raw.sameDay = true;
  return sanitizeSchedule(raw);
}

function anchorChoiceLabels(
  gapMinutes: number,
  count: number,
  timezone: string,
): { now: string; gap: string; nowFirst?: Date } {
  const now = new Date();
  const gapSpecsNow = specsFromGap(count, gapMinutes, 'now');
  const gapSpecsLater = specsFromGap(count, gapMinutes, 'after_gap');
  const nowInstants = materializeSequence(now, timezone, gapSpecsNow);
  const laterStart = new Date(now.getTime() + gapMinutes * 60_000);
  const laterInstants = materializeSequence(laterStart, timezone, gapSpecsLater);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: timezone }).format(d);
  const fmtTimes = (dates: Date[]) =>
    dates.map((d) => fmt(d)).join(', then ');
  return {
    now: `Today ${fmt(now)}, then ${fmtTimes(nowInstants.slice(1))}`,
    gap: `${fmt(laterInstants[0])}, then ${fmtTimes(laterInstants.slice(1))}`,
    nowFirst: nowInstants[0],
  };
}

function buildAnchorChoices(draft: ConversationDraft, timezone: string): DraftChoice[] {
  const spec = draft.sequenceSpec!;
  const gap = spec.gapMinutes ?? 0;
  const count = spec.count ?? 0;
  const labels = anchorChoiceLabels(gap, count, timezone);
  const choices: DraftChoice[] = [
    { id: 'anchor:now', label: labels.now, field: 'anchor', value: 'now' },
    { id: 'anchor:gap', label: labels.gap, field: 'anchor', value: 'after_gap' },
  ];
  if (labels.nowFirst && labels.nowFirst <= new Date()) {
    return choices.filter((c) => c.value !== 'now');
  }
  return choices;
}

function matchStepTimeCandidate(text: string, candidates: string[]): string | null {
  const clock = normalizeClockToken(text.trim());
  if (clock && candidates.includes(clock)) return clock;
  const t = normalize(text);
  for (const c of candidates) {
    const label = formatClockLabel(c).toLowerCase();
    if (t === label.replace(/\s+/g, ' ') || t === c) return c;
  }
  const bare = t.match(/^(\d{1,2})$/);
  if (bare) {
    const h = Number.parseInt(bare[1], 10);
    for (const c of candidates) {
      const ch = Number(c.slice(0, 2));
      if (ch === h || ch % 12 === h % 12) return c;
    }
  }
  return null;
}

const SEQ_HOUR_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
};

function bareHourCandidates(hour: number): string[] {
  if (hour < 1 || hour > 12) {
    if (hour > 23) return [];
    return [`${String(hour).padStart(2, '0')}:00`];
  }
  const am = hour === 12 ? 0 : hour;
  const pm = hour === 12 ? 12 : hour + 12;
  return [
    `${String(am).padStart(2, '0')}:00`,
    `${String(pm).padStart(2, '0')}:00`,
  ];
}

function sequenceStepsAreEmpty(steps: RawStep[]): boolean {
  return !steps.length || steps.every((s) => !s.spec && !s.candidates?.length);
}

function stepIsUsable(step: RawStep | undefined): boolean {
  return Boolean(step?.spec || step?.candidates?.length);
}

function sequenceStepsNeedFallback(steps: RawStep[]): boolean {
  return !steps.length || steps.some((s) => !stepIsUsable(s));
}

function missingStepNumbers(steps: RawStep[], expected: number): number[] {
  const missing: number[] = [];
  for (let i = 0; i < expected; i++) {
    if (!stepIsUsable(steps[i])) missing.push(i + 1);
  }
  return missing;
}

function sameDayConflictStep(spec: SequenceSpec, timezone: string): number | null {
  if (!spec.sameDay || spec.gapMinutes != null || !spec.count) return null;
  if (spec.steps.length !== spec.count) return null;
  const specs: StepSpec[] = [];
  for (const step of spec.steps) {
    if (!step.spec) return null;
    specs.push(step.spec);
  }
  if (specs.length < 2) return null;
  let instants: Date[];
  try {
    instants = materializeSequence(new Date(), timezone, specs);
  } catch {
    return null;
  }
  const day0 = civilDateInZone(new Date(), timezone);
  for (let i = 0; i < instants.length; i++) {
    if (civilDateInZone(instants[i], timezone) !== day0) return i;
  }
  return null;
}

function sequenceAmbiguityQuestion(amb: Ambiguity): string {
  if (amb.kind === 'count') {
    return 'How many sends do you want in this sequence?';
  }
  if (amb.kind === 'anchor') {
    return 'Starting today, or after the first gap?';
  }
  if (amb.kind === 'stepTime') {
    return `Which time did you mean — ${amb.candidates.map(formatClockLabel).join(' or ')}?`;
  }
  if (amb.kind === 'stepCountMismatch') {
    const ord = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
    const missing = amb.missingSteps.map(ord).join(', ');
    return `I have ${amb.parsed} of ${amb.expected} step times. When should the ${missing} step go out?`;
  }
  if (amb.kind === 'sameDayConflict') {
    return `Step ${amb.stepIndex + 1} would land after midnight if everything stays today. Is tomorrow OK for that step, or give me a same-day time?`;
  }
  const names = amb.choices.map((c) => c.label).join(', ');
  return `I found multiple templates for ${amb.hint} on step ${amb.stepIndex + 1}: ${names}. Which one should I use?`;
}

type ChainedHit = { index: number; len: number; step: RawStep };

// ponytail: narrow chained-step fallback — "now", "N hour(s) later", "at H(:MM)?".
// Upgrade path: LLM extraction when phrasing exceeds these patterns.
function parseChainedSequenceSteps(text: string): RawStep[] | null {
  const t = normalize(text);
  const hits: ChainedHit[] = [];

  for (const m of t.matchAll(/\bnow\b/g)) {
    const idx = m.index ?? 0;
    const before = t.slice(Math.max(0, idx - 4), idx);
    if (/\bnot\s$/.test(before)) continue;
    hits.push({
      index: idx,
      len: 3,
      step: { spec: { kind: 'after', minutes: 0, from: 'start' } },
    });
  }

  for (const m of t.matchAll(/\b(\d+|one|two|three|four|five)\s+hours?\s+(?:later|after(?:\s+(?:the\s+)?)?(?:first|previous|last|that|this|it)(?:\s+one)?)\b/g)) {
    const raw = m[1];
    const n = /\d/.test(raw) ? Number.parseInt(raw, 10) : SEQ_HOUR_WORDS[raw];
    if (!n || n < 1 || n > 168) continue;
    hits.push({
      index: m.index ?? 0,
      len: m[0].length,
      step: { spec: { kind: 'after', minutes: n * 60, from: 'previous' } },
    });
  }

  const atRe = /\b(?:next\s+)?at\s+(\d{1,2})(?:\s+(\d{2}))?(?:\s*(am|pm))?\b/g;
  for (const m of t.matchAll(atRe)) {
    let hour = Number.parseInt(m[1], 10);
    const minute = m[2] ? Number.parseInt(m[2], 10) : 0;
    const meridiem = m[3];
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) continue;

    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      hits.push({
        index: m.index ?? 0,
        len: m[0].length,
        step: {
          spec: {
            kind: 'at',
            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            dayOffset: 0,
          },
        },
      });
    } else if (m[2]) {
      if (hour > 23) continue;
      hits.push({
        index: m.index ?? 0,
        len: m[0].length,
        step: {
          spec: {
            kind: 'at',
            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            dayOffset: 0,
          },
        },
      });
    } else {
      const candidates = bareHourCandidates(hour);
      if (!candidates.length) continue;
      hits.push({
        index: m.index ?? 0,
        len: m[0].length,
        step: candidates.length === 1
          ? { spec: { kind: 'at', time: candidates[0], dayOffset: 0 } }
          : { candidates },
      });
    }
  }

  if (!hits.length) return null;

  hits.sort((a, b) => a.index - b.index || b.len - a.len);
  const picked: ChainedHit[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.index < cursor) continue;
    picked.push(h);
    cursor = h.index + h.len;
  }

  const steps = picked.slice(0, MAX_SEQUENCE_STEPS).map((h) => h.step);
  let seenNow = false;
  for (const step of steps) {
    if (step.spec?.kind === 'after' && step.spec.minutes === 0) {
      step.spec.from = seenNow ? 'previous' : 'start';
      seenNow = true;
    }
  }

  return steps.length ? steps : null;
}

function applyChainedStepFallback(draft: ConversationDraft, text: string): void {
  const spec = draft.sequenceSpec;
  if (!spec) return;
  const fallback = parseChainedSequenceSteps(text);
  if (!fallback?.length) return;

  const assign = (steps: RawStep[]): RawStep[] => {
    const count = spec.count;
    if (count != null && fallback.length > count) {
      return steps.map((s, i) => (stepIsUsable(s) ? s : fallback[i] ?? s)).slice(0, count);
    }
    if (count == null || fallback.length === count) {
      return steps.map((s, i) => (stepIsUsable(s) ? s : fallback[i] ?? s));
    }
    return steps.map((s, i) => (stepIsUsable(s) ? s : fallback[i] ?? s));
  };

  if (sequenceStepsAreEmpty(spec.steps)) {
    const count = spec.count;
    if (count != null && fallback.length > count) {
      spec.steps = fallback.slice(0, count);
    } else if (count == null || fallback.length === count) {
      spec.steps = fallback;
    } else if (fallback.length < count) {
      spec.steps = fallback;
    }
    return;
  }

  if (!sequenceStepsNeedFallback(spec.steps)) return;

  const merged = [...spec.steps];
  for (let i = 0; i < merged.length; i++) {
    if (!stepIsUsable(merged[i]) && fallback[i]) merged[i] = fallback[i];
  }
  const count = spec.count;
  const targetLen = count ?? Math.max(merged.length, fallback.length);
  for (let i = merged.length; i < targetLen && i < fallback.length; i++) {
    merged.push(fallback[i]);
  }
  spec.steps = assign(merged);
}

function existingSequenceSendCount(draft: ConversationDraft): number {
  if (draft.schedule?.frequency === 'once') return 1;
  if (draft.schedule?.frequency === 'sequence') return draft.schedule.steps?.length ?? 0;
  if (draft.sequenceSpec?.count != null) return draft.sequenceSpec.count;
  return draft.sequenceSpec?.steps.length ?? 0;
}

function materializedSequenceSpecFromDraft(draft: ConversationDraft): SequenceSpec | null {
  if (draft.schedule?.frequency === 'once') {
    const runAtDate = new Date(draft.schedule.runAt ?? Date.now());
    const runAt = Number.isNaN(runAtDate.getTime()) ? new Date().toISOString() : runAtDate.toISOString();
    return {
      startAt: runAt,
      count: 1,
      steps: [
        {
          spec: { kind: 'after', minutes: 0, from: 'start' },
          ...(draft.templateId ? { templateId: draft.templateId } : {}),
        },
      ],
    };
  }
  if (draft.schedule?.frequency === 'sequence') {
    const steps = draft.schedule.steps ?? [];
    if (!steps.length) return null;
    const startAtDate = new Date(draft.schedule.startAt ?? Date.now());
    const startAt = Number.isNaN(startAtDate.getTime()) ? new Date().toISOString() : startAtDate.toISOString();
    return {
      startAt,
      count: steps.length,
      steps: steps.map((step) => ({
        spec: step.spec,
        ...(step.templateId ? { templateId: step.templateId } : {}),
      })),
    };
  }
  return null;
}

function applyAddMoreSequenceIntent(draft: ConversationDraft, text: string): boolean {
  const addCount = parseAdditionalSequenceCount(text);
  if (addCount == null || addCount < 1) return false;

  const existingCount = existingSequenceSendCount(draft);
  if (existingCount < 1) return false;

  if (!draft.sequenceSpec) {
    const seeded = materializedSequenceSpecFromDraft(draft);
    if (seeded) {
      draft.sequenceSpec = seeded;
      draft.schedule = undefined;
    } else {
      draft.sequenceSpec = { steps: [] };
    }
  }
  const spec = draft.sequenceSpec;
  if (!spec) return false;

  const targetCount = Math.min(MAX_SEQUENCE_STEPS, existingCount + addCount);
  const extras = parseChainedSequenceSteps(text) ?? [];
  const room = Math.max(0, targetCount - spec.steps.length);
  if (room && extras.length) spec.steps.push(...extras.slice(0, room));
  spec.count = targetCount;
  return true;
}

function seedSequenceFromText(draft: ConversationDraft, text: string): void {
  if (!draft.sequenceSpec) draft.sequenceSpec = { steps: [] };
  const gap = parseIntervalGapMinutes(text);
  if (gap) draft.sequenceSpec.gapMinutes = gap;
  // An explicit "3 mails" always wins; the marker chain only speaks when it says nothing.
  const count = parseSequenceCount(text) ?? parseChainMarkerCount(text);
  if (count != null) draft.sequenceSpec.count = count;
  if (/\btoday\b/.test(normalize(text))) draft.sequenceSpec.sameDay = true;
  applyChainedStepFallback(draft, text);
}

function applySequenceCountAnswer(draft: ConversationDraft, text: string): 'ok' | 'refuse' | 'retry' {
  if (isForeverSequence(text)) return 'refuse';
  const count = parseSequenceCount(text);
  if (count == null) return 'retry';
  if (count <= 0) return 'retry';
  if (count > MAX_SEQUENCE_STEPS) return 'refuse';
  if (!draft.sequenceSpec) draft.sequenceSpec = { steps: [] };
  if (count === 1) {
    draft.schedule = { frequency: 'once', runAt: new Date().toISOString() };
    draft.executionMode = 'once';
    draft.sequenceRequested = false;
    draft.sequenceSpec = undefined;
    return 'ok';
  }
  draft.sequenceSpec.count = count;
  return 'ok';
}

function resolveSilentStepTimes(draft: ConversationDraft, timezone: string): void {
  const spec = draft.sequenceSpec;
  if (!spec) return;
  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i];
    if (!step.candidates?.length) continue;
    const prev = previousInstantForStep(spec, i, timezone);
    const clean = cleanCandidates(step.candidates, prev, timezone);
    if (clean.length === 1) {
      step.spec = { kind: 'at', time: clean[0], dayOffset: 0 };
      step.candidates = undefined;
      continue;
    }
    if (clean.length === 0) {
      const prevCivil = civilDateInZone(prev, timezone);
      const y = Number(prevCivil.slice(0, 4));
      const mo = Number(prevCivil.slice(5, 7));
      const d = Number(prevCivil.slice(8, 10));
      let best: { time: string; at: Date } | null = null;
      for (const time of step.candidates) {
        if (!HHMM_RE.test(time)) continue;
        const hour = Number(time.slice(0, 2));
        const minute = Number(time.slice(3, 5));
        const rolled = addCivilDays(y, mo, d, 1);
        const at = utcFromZoned(timezone, rolled.year, rolled.month, rolled.day, hour, minute);
        if (at > prev && (!best || at < best.at)) best = { time, at };
      }
      if (best) {
        step.spec = { kind: 'at', time: best.time, dayOffset: 0 };
        step.candidates = undefined;
      }
    }
  }
}

function processSequenceDraft(draft: ConversationDraft, text: string, raw?: LlmInterpretation): void {
  seedSequenceFromText(draft, text);
  if (raw?.schedule && typeof raw.schedule === 'object') {
    const sanitized = sanitizeSchedule(raw.schedule);
    if (sanitized?.frequency === 'sequence' && draft.sequenceRequested) {
      draft.schedule = sanitized;
      draft.sequenceSpec = undefined;
      return;
    }
    if (draft.sequenceRequested) {
      draft.sequenceSpec = mergeSequenceSpec(
        draft.sequenceSpec,
        extractSequenceSpecFromRaw(raw.schedule as Record<string, unknown>),
      );
    }
  }
  applyChainedStepFallback(draft, text);
  resolveSilentStepTimes(draft, workflowTimezone());
  const mat = tryMaterializeSequenceDraft(draft, workflowTimezone());
  if (mat) {
    draft.schedule = mat;
    draft.sequenceSpec = undefined;
  }
}

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

  if (frequency === 'sequence') {
    const startAtRaw = String(s.startAt ?? '').trim();
    const startAt = new Date(startAtRaw);
    if (!startAtRaw || Number.isNaN(startAt.getTime())) return null;

    const rawSteps = Array.isArray(s.steps) ? s.steps : [];
    // One step is not a sequence, it is a `once`. Let the caller model it as such.
    if (rawSteps.length < 2 || rawSteps.length > MAX_SEQUENCE_STEPS) return null;

    const specs: StepSpec[] = [];
    const templateIds: Array<string | undefined> = [];
    for (const entry of rawSteps) {
      const step = (entry ?? {}) as Record<string, unknown>;
      const rawSpec = (step.spec ?? {}) as Record<string, unknown>;
      const kind = String(rawSpec.kind ?? '');
      if (kind === 'after') {
        const minutes = Number(rawSpec.minutes);
        if (!Number.isInteger(minutes) || minutes < 0) return null;
        const from = String(rawSpec.from ?? '');
        if (from !== 'start' && from !== 'previous') return null;
        specs.push({ kind: 'after', minutes, from });
      } else if (kind === 'at') {
        let time = String(rawSpec.time ?? '').trim();
        if (/^\d:\d{2}$/.test(time)) time = `0${time}`;
        if (!HHMM_RE.test(time)) return null;
        const dayOffset = Number(rawSpec.dayOffset ?? 0);
        if (!Number.isInteger(dayOffset) || dayOffset < 0) return null;
        specs.push({ kind: 'at', time, dayOffset });
      } else {
        return null;
      }
      const tid = step.templateId == null ? undefined : String(step.templateId).trim();
      templateIds.push(tid || undefined);
    }

    const timezone = workflowTimezone();
    let instants: Date[];
    try {
      instants = materializeSequence(startAt, timezone, specs);
    } catch {
      // materializeSequence throws on anything structurally impossible — out of order,
      // unplaceable, malformed. A sequence is accepted whole or not at all; there is no
      // partial credit, because a repaired sequence is a different plan than the one asked
      // for and nobody would be told.
      return null;
    }

    for (let i = 1; i < instants.length; i++) {
      if (instants[i].getTime() - instants[i - 1].getTime() < MIN_STEP_GAP_MINUTES * 60_000) {
        return null;
      }
    }
    const spanMs = instants[instants.length - 1].getTime() - startAt.getTime();
    if (spanMs > MAX_SEQUENCE_SPAN_DAYS * 24 * 60 * 60 * 1000) return null;

    // The user scoped the request to one day ("send 3 mails today"). materializeSequence
    // rolls a step that would land before its predecessor, which is right in general and
    // wrong here — it would quietly move the third mail to tomorrow.
    if (s.sameDay === true) {
      const day0 = civilDateInZone(startAt, timezone);
      if (instants.some((d) => civilDateInZone(d, timezone) !== day0)) return null;
    }

    // endDate and maxRuns are stripped on purpose: the step list IS the bound, and a stray
    // maxRuns would make exhaustedByLimits complete the sequence early.
    return {
      frequency: 'sequence',
      startAt: startAt.toISOString(),
      steps: instants.map((d, i) => ({
        spec: specs[i],
        at: d.toISOString(),
        ...(templateIds[i] ? { templateId: templateIds[i] } : {}),
      })),
    };
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
  let schedule = opts.deterministicSchedule ?? sanitizeSchedule(raw.schedule);
  if (schedule?.frequency === 'sequence' && !draft.sequenceRequested) {
    schedule = null;
  }
  if (schedule) {
    draft.schedule = schedule;
    draft.executionMode = executionModeOf(schedule);
    if (schedule.frequency === 'sequence') draft.sequenceSpec = undefined;
  } else if (draft.sequenceRequested && raw.schedule) {
    draft.sequenceSpec = mergeSequenceSpec(
      draft.sequenceSpec,
      extractSequenceSpecFromRaw(raw.schedule as Record<string, unknown>),
    );
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

function cleanStepTemplateHint(raw: string): string {
  return normalize(raw)
    .replace(/\s+and\s*$/i, '')
    .replace(/\b(again|the|a|an|template|mail|use|make|set|put|keep|it|only|just|actually)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveStepOrdinal(token: string, stepCount: number): number | null {
  const t = normalize(token);
  if (/\b(first|1st)\b/.test(t) || t === '1') return 0;
  if (/\b(second|2nd)\b/.test(t) || t === '2') return 1;
  if (/\b(third|3rd)\b/.test(t) || t === '3') return 2;
  if (/\b(fourth|4th)\b/.test(t) || t === '4') return 3;
  if (/\b(fifth|5th)\b/.test(t) || t === '5') return 4;
  if (/\b(last|final)\b/.test(t)) return stepCount > 0 ? stepCount - 1 : null;
  const mailN = t.match(/mail\s*(\d+)/);
  if (mailN) {
    const n = Number.parseInt(mailN[1], 10);
    return n >= 1 && n <= stepCount ? n - 1 : null;
  }
  return null;
}

const STEP_TARGET_TOKENS =
  'first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final|rest|others|remaining|mail\\s*\\d+';
const STEP_SPREAD_RE = /^(?:rest|others|remaining)$/i;
const STEP_INLINE_TEMPLATE_RE =
  /\b(?:one|another|next|then|and then|after that|followed by)\s+(.+?)\s+(?:mails?|emails?)\b(?=\s+(?:right\s+now\b|now\b|today\b|tomorrow\b|later\b|at\s+\d|in\s+\d|after\s+\d|\d{1,3}\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?)\b|daily\b|weekly\b|monthly\b|every\b))/gi;

/**
 * "one intro mail now then follow up mail daily at 12" — infer step hints from chained
 * clauses, in order. This only runs when no explicit "for first ... for second ..."
 * directives were found.
 */
function parseInlineStepTemplateHints(text: string, stepCount: number): Array<{ index: number; hint: string }> {
  if (stepCount < 2) return [];
  const hints: Array<{ index: number; hint: string }> = [];
  for (const m of text.matchAll(STEP_INLINE_TEMPLATE_RE)) {
    const hint = cleanStepTemplateHint(m[1]);
    if (!hint) continue;
    const index = hints.length;
    if (index >= stepCount) break;
    hints.push({ index, hint });
  }
  return hints;
}

/**
 * "for first mail use introduction, for rest use follow up" — one entry per step. A spread
 * target ("rest") expands to whatever steps no explicit directive already claimed.
 */
function parsePerStepTemplateHints(text: string, stepCount: number): Array<{ index: number; hint: string }> {
  if (stepCount < 1) return [];
  const forwardRe = new RegExp(
    `\\b(?:for|in)\\s+(?:the\\s+)?(${STEP_TARGET_TOKENS})\\s+(?:mails?\\s+)?(?:use\\s+)?(.+?)`
      + `(?=\\s+(?:for|in)\\s+(?:the\\s+)?(?:${STEP_TARGET_TOKENS})\\s|$)`,
    'gi',
  );
  const reverseRe = new RegExp(
    `(?:^|\\b(?:and|then|also|only)\\b)\\s*([^,.!?;]{1,80}?)\\s+(?:in|for)\\s+(?:the\\s+)?(${STEP_TARGET_TOKENS})\\b`,
    'gi',
  );
  const hints: Array<{ index: number; hint: string }> = [];
  const spread: string[] = [];
  for (const m of text.matchAll(forwardRe)) {
    const hint = cleanStepTemplateHint(m[2]);
    if (!hint) continue;
    if (STEP_SPREAD_RE.test(m[1].trim())) {
      spread.push(hint);
      continue;
    }
    const index = resolveStepOrdinal(m[1], stepCount);
    if (index == null || index < 0 || index >= stepCount) continue;
    hints.push({ index, hint });
  }

  const claimed = new Set(hints.map((h) => h.index));
  for (const hint of spread) {
    for (let i = 0; i < stepCount; i++) {
      if (claimed.has(i)) continue;
      hints.push({ index: i, hint });
      claimed.add(i);
    }
  }
  for (const m of text.matchAll(reverseRe)) {
    const index = resolveStepOrdinal(m[2], stepCount);
    if (index == null || index < 0 || index >= stepCount || claimed.has(index)) continue;
    const hint = cleanStepTemplateHint(m[1]);
    if (!hint) continue;
    hints.push({ index, hint });
    claimed.add(index);
  }
  if (hints.length) return hints;
  return parseInlineStepTemplateHints(text, stepCount);
}

function foldTemplateText(s: string): string {
  return normalize(s).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactTemplateText(s: string): string {
  return foldTemplateText(s).replace(/\s+/g, '');
}

function matchTemplatesForStepHint(
  hint: string,
  templates: TemplateRecord[],
  stepIndex: number,
): { kind: 'single'; id: string; name: string } | { kind: 'choices'; choices: DraftChoice[] } | { kind: 'none' } {
  const q = cleanStepTemplateHint(hint);
  if (!q) return { kind: 'none' };
  const cq = compactTemplateText(q);

  const contains = templates.filter((t) => {
    const name = foldTemplateText(t.name);
    const desc = foldTemplateText(t.description);
    const cn = compactTemplateText(t.name);
    const cd = compactTemplateText(t.description);
    if (name.includes(q) || desc.includes(q) || cn.includes(cq) || cd.includes(cq)) return true;
    const tokens = q
      .split(/\s+/)
      .filter((w) => w.length > 1 && !['make', 'set', 'put', 'it', 'only', 'just', 'actually'].includes(w));
    return tokens.length > 0 && tokens.every((w) => name.includes(w) || desc.includes(w) || cn.includes(compactTemplateText(w)));
  });

  if (contains.length === 1) {
    return { kind: 'single', id: contains[0].id, name: contains[0].name };
  }
  if (contains.length > 1) {
    return {
      kind: 'choices',
      choices: contains.slice(0, 5).map((t) => ({
        id: `stepTemplate:${stepIndex}:${t.id}`,
        label: t.name,
        sublabel: hint,
        field: 'stepTemplate' as const,
        value: t.id,
      })),
    };
  }

  const scored = templates
    .map((t) => ({ t, score: scoreTemplateMatch(t, q) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { kind: 'single', id: scored[0].t.id, name: scored[0].t.name };
  if (scored.length > 1) {
    return {
      kind: 'choices',
      choices: scored.slice(0, 5).map(({ t }) => ({
        id: `stepTemplate:${stepIndex}:${t.id}`,
        label: t.name,
        sublabel: hint,
        field: 'stepTemplate' as const,
        value: t.id,
      })),
    };
  }
  return { kind: 'none' };
}

function applyPerStepTemplateHints(
  draft: ConversationDraft,
  text: string,
  templates: TemplateRecord[],
): Ambiguity | null {
  let spec = draft.sequenceSpec;
  const scheduledSteps = draft.schedule?.frequency === 'sequence' ? draft.schedule.steps ?? [] : [];
  const stepCount = spec?.count ?? spec?.steps.length ?? scheduledSteps.length;
  if (stepCount < 2) return null;

  const hints = parsePerStepTemplateHints(text, stepCount);
  if (!hints.length) return null;
  if (!spec && scheduledSteps.length) {
    spec = {
      startAt: draft.schedule?.frequency === 'sequence' ? draft.schedule.startAt : undefined,
      count: scheduledSteps.length,
      steps: scheduledSteps.map((step) => ({
        spec: step.spec,
        ...(step.templateId ? { templateId: step.templateId } : {}),
      })),
    };
    draft.sequenceSpec = spec;
    draft.schedule = undefined;
  }
  if (!spec) return null;

  for (const { index, hint } of hints) {
    const match = matchTemplatesForStepHint(hint, templates, index);
    if (match.kind === 'single') {
      if (!spec.steps[index]) spec.steps[index] = {};
      spec.steps[index].templateId = match.id;
      continue;
    }
    if (match.kind === 'choices') {
      return { kind: 'stepTemplate', stepIndex: index, hint, choices: match.choices };
    }
  }
  return null;
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
  if (field === 'templateId') return !draft.templateId;
  if (field === 'recipientId') return !draft.recipientIds.length;
  if (field === 'anchor') return !draft.sequenceSpec?.anchor;
  if (field === 'stepTime') return true;
  if (field === 'stepTemplate') {
    const idx = Number(draft.pendingChoices?.[0]?.id.split(':')[1] ?? -1);
    return idx >= 0 && !draft.sequenceSpec?.steps[idx]?.templateId;
  }
  return false;
}

function applyChoice(draft: ConversationDraft, choice: DraftChoice): ConversationDraft {
  if (choice.field === 'templateId') {
    draft.templateId = choice.value;
    draft.templateHint = undefined;
  } else if (choice.field === 'anchor') {
    if (!draft.sequenceSpec) draft.sequenceSpec = { steps: [] };
    draft.sequenceSpec.anchor = choice.value as 'now' | 'after_gap';
  } else if (choice.field === 'stepTime') {
    const idx = Number(choice.id.split(':')[1] ?? 0);
    if (draft.sequenceSpec?.steps[idx]) {
      draft.sequenceSpec.steps[idx].spec = { kind: 'at', time: choice.value, dayOffset: 0 };
      draft.sequenceSpec.steps[idx].candidates = undefined;
    }
  } else if (choice.field === 'stepTemplate') {
    const idx = Number(choice.id.split(':')[1] ?? 0);
    if (!draft.sequenceSpec) draft.sequenceSpec = { steps: [] };
    if (!draft.sequenceSpec.steps[idx]) draft.sequenceSpec.steps[idx] = {};
    draft.sequenceSpec.steps[idx].templateId = choice.value;
  } else if (!draft.recipientIds.includes(choice.value)) {
    draft.recipientIds = [...draft.recipientIds, choice.value];
  }
  draft.pendingChoices = undefined;
  const mat = tryMaterializeSequenceDraft(draft, workflowTimezone());
  if (mat) {
    draft.schedule = mat;
    draft.sequenceSpec = undefined;
  }
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
  sequenceRequested?: boolean;
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
    if (ctx.sequenceRequested) {
      if (count <= 1) {
        return 'How should the sequence go? Give me the steps — for example: "an hour from now, then 2pm tomorrow, then 2 hours after that."';
      }
      return `I still need the sequence steps. You can also tell me how many sends and which template each one uses. For example: "an hour from now, then 2pm tomorrow, then 2 hours after that."`;
    }
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

/** Every distinct template this draft will send, workflow default first. */
function draftTemplateIds(draft: ConversationDraft): string[] {
  const ids = new Set<string>();
  if (draft.templateId) ids.add(draft.templateId);
  for (const step of draft.schedule?.steps ?? []) {
    if (step.templateId) ids.add(step.templateId);
  }
  for (const step of draft.sequenceSpec?.steps ?? []) {
    if (step.templateId) ids.add(step.templateId);
  }
  return [...ids];
}

async function missingVariables(
  userId: string,
  draft: ConversationDraft,
): Promise<string[] | null> {
  const ids = draftTemplateIds(draft);
  if (!ids.length) return null;
  const missing = new Set<string>();
  for (const id of ids) {
    try {
      const template = await loadTemplate(userId, id);
      for (const name of missingExtraVars(template.subject, template.body, draft.variables)) {
        missing.add(name);
      }
    } catch {
      // A template that no longer loads is caught by validateCreateContract before send.
    }
  }
  return missing.size ? [...missing] : null;
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
    if (action === 'update') return wf.status === 'active' || wf.status === 'paused';
    if (action === 'cancel') return wf.status !== 'completed' && wf.status !== 'cancelled';
    return false;
  });
}

function noCandidatesMessage(action: WorkflowAction): string {
  if (action === 'pause') return 'You do not have any active recurring emails to pause.';
  if (action === 'resume') return 'You do not have any paused emails to resume.';
  if (action === 'update') return 'You do not have any active sequences to edit.';
  return 'You do not have any scheduled emails to cancel.';
}

function mergeWorkflowIntoDraft(draft: ConversationDraft, wf: MailWorkflow): void {
  draft.action = 'update';
  draft.workflowId = wf.id;
  if (!draft.templateId) draft.templateId = wf.templateId;
  if (!draft.recipientIds.length) draft.recipientIds = [...wf.recipientIds];
  if (!draft.schedule) draft.schedule = modelScheduleToContract(wf.schedule);
  if (!Object.keys(draft.variables).length) draft.variables = { ...wf.variables };
  if (draft.schedule?.frequency === 'sequence') draft.sequenceRequested = true;
}

function updateDraftHasChanges(draft: ConversationDraft, wf: MailWorkflow): boolean {
  if (draft.templateId && draft.templateId !== wf.templateId) return true;
  if (
    draft.recipientIds.length
    && JSON.stringify(draft.recipientIds) !== JSON.stringify(wf.recipientIds)
  ) {
    return true;
  }
  if (
    draft.schedule
    && JSON.stringify(draft.schedule) !== JSON.stringify(modelScheduleToContract(wf.schedule))
  ) {
    return true;
  }
  return false;
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
  if (action === 'update') {
    const wf = await getWorkflow(userId, workflowId);
    mergeWorkflowIntoDraft(draft, wf);
    if (!updateDraftHasChanges(draft, wf)) {
      await saveDraft(userId, draft);
      return {
        kind: 'assistant_message',
        message:
          assistantReply?.trim()
          || 'What should I change — a step time, template, or recipient?',
        suggestions: ['Move step 2 to 4pm', 'Change the template on step 3'],
      };
    }
    return handleCreateDraft(userId, draft, requestId, assistantReply);
  }

  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    await clearDraft(userId);
    return {
      kind: 'assistant_message',
      message: 'I did not understand that command. Try pause, resume, cancel, or edit.',
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
    const question =
      first.field === 'stepTime'
        ? `Which time did you mean — ${draft.pendingChoices.map((c) => c.label).join(' or ')}?`
        : first.field === 'stepTemplate'
          ? (() => {
              const stepNum = Number(first.id.split(':')[1]) + 1;
              const hint = first.sublabel ?? 'that';
              const names = draft.pendingChoices.map((c) => c.label).join(', ');
              return `I found multiple templates for ${hint} on step ${stepNum}: ${names}. Which one should I use?`;
            })()
        : first.field === 'anchor'
          ? 'Starting today, or after the first gap?'
          : first.field === 'templateId'
            ? 'I found a few matching templates. Which one should I use? Reply with the name or the number.'
            : 'I found more than one match. Which one did you mean? Reply with the name or the number.';
    return {
      kind: 'assistant_message',
      message: question,
      choices: draft.pendingChoices.map(({ id, label, sublabel }) => ({ id, label, sublabel })),
    };
  }

  const timezone = workflowTimezone();
  const amb = nextAmbiguity(draft);
  if (amb) {
    if (amb.kind === 'anchor') {
      draft.pendingChoices = buildAnchorChoices(draft, timezone);
    } else if (amb.kind === 'stepTime') {
      draft.pendingChoices = amb.candidates.map((c) => ({
        id: `stepTime:${amb.stepIndex}:${c}`,
        label: formatClockLabel(c),
        field: 'stepTime' as const,
        value: c,
      }));
    } else if (amb.kind === 'stepTemplate') {
      draft.pendingChoices = amb.choices;
    }
    const count = noteAsked(draft, 'schedule');
    const question =
      amb.kind === 'count'
        ? count <= 1
          ? 'How many sends do you want in this sequence?'
          : 'How many sends should the sequence include?'
        : sequenceAmbiguityQuestion(amb);
    await saveDraft(userId, draft);
    return {
      kind: 'assistant_message',
      message: withQuestion(assistantReply, question),
      choices: draft.pendingChoices?.map(({ id, label, sublabel }) => ({ id, label, sublabel })),
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
            sequenceRequested: draft.sequenceRequested,
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

  if (draft.action === 'update' && draft.workflowId) {
    toAwaitingUpdateConfirmation(draft, draft.workflowId, confirmRequestId);
  } else {
    toAwaitingCreateConfirmation(draft, confirmRequestId);
  }
  refreshDraftSteps(draft, extraMissing);
  await saveDraft(userId, draft);

  const confirmAction = {
    type: (draft.action === 'update' ? 'update' : 'schedule') as 'schedule' | 'update',
    label: draft.action === 'update' ? 'Confirm changes' : confirmLabelFor(draft.schedule),
    ...(draft.action === 'update' && draft.workflowId ? { workflowId: draft.workflowId } : {}),
  };

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

  if (kind === 'update') {
    const workflowId = draft.confirmationWorkflowId ?? draft.workflowId;
    if (!workflowId) {
      await clearDraft(userId);
      return {
        kind: 'assistant_message',
        message: 'That confirmation expired. Please run the command again.',
      };
    }
    if (!draftIsComplete(draft)) {
      toEditing(draft);
      await saveDraft(userId, draft);
      return {
        kind: 'assistant_message',
        message: "Something is missing from that edit — let's fill it in before I apply anything.",
      };
    }
    const contract = draftToContract(draft, requestId);
    const workflow = await updateWorkflow(userId, workflowId, contract);
    await clearDraft(userId);
    const template = await loadTemplate(userId, workflow.templateId);
    return {
      kind: 'assistant_message',
      message: `Updated **${template.name}**.`,
      workflows: [workflow],
    };
  }

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
  if (draft.awaitingConfirmation !== 'create' && draft.awaitingConfirmation !== 'update') {
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
  const cadenceIntent = recurringCadenceIntent(text);

  // ---- picking from an outstanding shortlist, ahead of everything ----
  // Must beat parseWhen: while "which one did you mean?" is open, a bare "2" is a
  // selection, not two o'clock.
  if (draft.pendingChoices?.length) {
    const field = draft.pendingChoices[0].field;
    const picked =
      field === 'stepTime' ? null : parseChoiceOrdinal(text, draft.pendingChoices.length);
    if (picked) {
      draft = applyChoice(draft, draft.pendingChoices[picked - 1]);
      await saveDraft(userId, draft);
      const resolved = await resolveDraft(userId, draft);
      return handleCreateDraft(userId, resolved.draft, requestId, undefined, resolved.autoTemplateName);
    }
    if (field === 'stepTemplate') {
      const tplMatch = matchTemplatesFromText(
        text,
        draft.pendingChoices.map((c) => ({ id: c.value, name: c.label, description: '' })),
      );
      if (tplMatch.kind === 'single') {
        const choice = draft.pendingChoices.find((c) => c.value === tplMatch.id);
        if (choice) {
          draft = applyChoice(draft, choice);
          await saveDraft(userId, draft);
          const resolved = await resolveDraft(userId, draft);
          return handleCreateDraft(userId, resolved.draft, requestId, undefined, resolved.autoTemplateName);
        }
      }
    }
    if (field === 'stepTime') {
      const match = matchStepTimeCandidate(text, draft.pendingChoices.map((c) => c.value));
      if (match) {
        const choice = draft.pendingChoices.find((c) => c.value === match);
        if (choice) {
          draft = applyChoice(draft, choice);
          await saveDraft(userId, draft);
          const resolved = await resolveDraft(userId, draft);
          return handleCreateDraft(userId, resolved.draft, requestId, undefined, resolved.autoTemplateName);
        }
      }
      const correction = normalizeClockToken(text);
      if (correction && draft.sequenceSpec) {
        const idx = Number(draft.pendingChoices[0].id.split(':')[1] ?? 0);
        if (draft.sequenceSpec.steps[idx]) {
          draft.sequenceSpec.steps[idx].spec = { kind: 'at', time: correction, dayOffset: 0 };
          draft.sequenceSpec.steps[idx].candidates = undefined;
          draft.pendingChoices = undefined;
          const mat = tryMaterializeSequenceDraft(draft, timezone);
          if (mat) {
            draft.schedule = mat;
            draft.sequenceSpec = undefined;
          }
          await saveDraft(userId, draft);
          const resolved = await resolveDraft(userId, draft);
          return handleCreateDraft(userId, resolved.draft, requestId, undefined, resolved.autoTemplateName);
        }
      }
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

  if (inCreateFlow && cadenceIntent != null && draft.sequenceSpec?.count == null) {
    draft.sequenceRequested = false;
    draft.sequenceSpec = undefined;
  }

  const addMoreApplied = inCreateFlow && cadenceIntent == null && applyAddMoreSequenceIntent(draft, text);
  if (inCreateFlow && cadenceIntent == null && (addMoreApplied || looksLikeSequence(text))) {
    draft.sequenceRequested = true;
    if (!addMoreApplied) seedSequenceFromText(draft, text);
    toCollecting(draft);
    if (isForeverSequence(text) && !draft.sequenceSpec?.count) {
      await saveDraft(userId, draft);
      return {
        kind: 'assistant_message',
        message:
          'I can only run open-ended schedules daily, weekly or monthly — a custom gap like every 2 days needs a number of sends. How many, or shall I make it weekly?',
      };
    }
  }

  // ---- deterministic time parsing, ahead of the model ----
  const customRecurringGap = cadenceIntent === 'clarify' && parseIntervalGapMinutes(text) != null;
  const normalizedTimeText = text.replace(/\b(?:12\s+)?noon\b/gi, '12 pm');
  const when = draft.sequenceRequested || customRecurringGap
    ? null
    : parseWhen(normalizedTimeText, timezone)
      ?? parseTimeCorrection(normalizedTimeText, draft.schedule, timezone);
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
    if (draft.sequenceRequested || draft.sequenceSpec) {
      const countAmb = nextAmbiguity(draft);
      if (countAmb?.kind === 'count') {
        const countAnswer = applySequenceCountAnswer(draft, text);
        if (countAnswer === 'refuse') {
          const n = parseSequenceCount(text);
          await saveDraft(userId, draft);
          if (n != null && n > MAX_SEQUENCE_STEPS) {
            return {
              kind: 'assistant_message',
              message: `I can schedule up to ${MAX_SEQUENCE_STEPS} sends in one sequence. How many do you want, within that limit?`,
            };
          }
          return {
            kind: 'assistant_message',
            message:
              'I can only run open-ended schedules daily, weekly or monthly — a custom gap like every 2 days needs a number of sends. How many, or shall I make it weekly?',
          };
        }
      }
      const stepAmb = nextAmbiguity(draft);
      if (stepAmb?.kind === 'stepTime' && isDeflection(text)) {
        const pick = stepAmb.candidates[0];
        if (draft.sequenceSpec?.steps[stepAmb.stepIndex]) {
          draft.sequenceSpec.steps[stepAmb.stepIndex].spec = { kind: 'at', time: pick, dayOffset: 0 };
          draft.sequenceSpec.steps[stepAmb.stepIndex].candidates = undefined;
        }
      }
      processSequenceDraft(draft, text, parsed);
      const templates = await templateRecords(userId);
      const tplAmb = applyPerStepTemplateHints(draft, text, templates);
      if (tplAmb?.kind === 'stepTemplate') {
        draft.pendingChoices = tplAmb.choices;
      } else {
        const mat = tryMaterializeSequenceDraft(draft, workflowTimezone());
        if (mat) {
          draft.schedule = mat;
          draft.sequenceSpec = undefined;
        }
      }
    }
    if (draft.action === 'update') {
      if (inCreateFlow) {
        draft.action = 'create';
        draft.workflowHint = undefined;
        draft.workflowId = undefined;
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

  if (draft.action === 'update') {
    if (!draft.workflowId) {
      return handleManagementAction(userId, draft, requestId, assistantReply);
    }
    const resolved = await resolveDraft(userId, draft);
    draft = refreshDraftSteps(resolved.draft);
    return handleCreateDraft(userId, draft, requestId, assistantReply, resolved.autoTemplateName);
  }

  if (draft.action !== 'create') {
    return handleManagementAction(userId, draft, requestId, assistantReply);
  }

  const resolved = await resolveDraft(userId, draft);
  draft = refreshDraftSteps(resolved.draft);
  if (cadenceIntent === 'clarify') {
    draft.sequenceRequested = false;
    draft.sequenceSpec = undefined;
    if (customRecurringGap) draft.schedule = undefined;
    await saveDraft(userId, draft);
    return { kind: 'assistant_message', message: RECURRING_MODE_QUESTION };
  }
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
  const withFrozenNow = <T>(iso: string, fn: () => T): T => {
    const RealDate = Date;
    const fixed = new RealDate(iso);
    class FrozenDate extends RealDate {
      constructor(value?: string | number | Date) {
        if (value == null) {
          super(fixed.getTime());
        } else if (value instanceof RealDate) {
          super(value.getTime());
        } else {
          super(value);
        }
      }
      static now(): number {
        return fixed.getTime();
      }
    }
    (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
    try {
      return fn();
    } finally {
      (globalThis as unknown as { Date: DateConstructor }).Date = RealDate;
    }
  };

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

  const seqStart = '2026-08-21T04:30:00.000Z';
  const seqStep = { spec: { kind: 'after', minutes: 60, from: 'previous' } };
  assert.equal(sanitizeSchedule({ frequency: 'sequence', startAt: seqStart, steps: [seqStep] }), null);
  assert.equal(
    sanitizeSchedule({
      frequency: 'sequence',
      startAt: seqStart,
      steps: Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, () => seqStep),
    }),
    null,
  );
  assert.equal(
    sanitizeSchedule({
      frequency: 'sequence',
      startAt: seqStart,
      steps: [
        { spec: { kind: 'after', minutes: 0, from: 'start' } },
        { spec: { kind: 'after', minutes: 1, from: 'previous' } },
      ],
    }),
    null,
  );
  assert.equal(
    sanitizeSchedule({
      frequency: 'sequence',
      startAt: seqStart,
      steps: [
        { spec: { kind: 'after', minutes: 0, from: 'start' } },
        { spec: { kind: 'at', time: '10:00', dayOffset: 400 } },
      ],
    }),
    null,
  );
  assert.equal(
    sanitizeSchedule({
      frequency: 'sequence',
      startAt: seqStart,
      steps: [seqStep, { spec: { kind: 'bogus' } }],
    }),
    null,
  );
  assert.equal(sanitizeSchedule({ frequency: 'sequence', startAt: 'not-a-date', steps: [seqStep, seqStep] }), null);
  assert.equal(
    sanitizeSchedule({
      frequency: 'sequence',
      startAt: seqStart,
      sameDay: true,
      steps: [
        { spec: { kind: 'at', time: '10:00', dayOffset: 0 } },
        { spec: { kind: 'at', time: '09:00', dayOffset: 0 } },
      ],
    }),
    null,
  );
  const validSeq = sanitizeSchedule({
    frequency: 'sequence',
    startAt: seqStart,
    endDate: '2027-01-01',
    maxRuns: 5,
    steps: [
      { spec: { kind: 'after', minutes: 60, from: 'start' } },
      { spec: { kind: 'after', minutes: 60, from: 'previous' } },
      { spec: { kind: 'after', minutes: 60, from: 'previous' } },
    ],
  });
  assert.ok(validSeq);
  assert.equal(validSeq?.frequency, 'sequence');
  assert.equal(validSeq?.steps?.length, 3);
  assert.equal(validSeq?.endDate, undefined);
  assert.equal(validSeq?.maxRuns, undefined);
  for (let i = 1; i < (validSeq?.steps?.length ?? 0); i++) {
    assert.ok(
      new Date(validSeq!.steps![i].at) > new Date(validSeq!.steps![i - 1].at),
      'sequence steps must be strictly increasing',
    );
  }

  assert.equal(looksLikeSequence('every 2 days'), true);
  assert.equal(looksLikeSequence('every day at 10am'), false);
  const recurringBugText =
    'create a sequence for prakhar send one introduction mail now then follow up mail daily at 12 noon';
  assert.equal(recurringCadenceIntent(recurringBugText), 'clarify');
  assert.notEqual(
    recurringCadenceIntent(recurringBugText),
    null,
    'mixed now-then-daily intent must bypass the generic sequence count branch',
  );
  assert.equal(recurringCadenceIntent('send the follow-up daily at 12 noon'), 'recurring');
  assert.equal(recurringCadenceIntent('send the follow-up every 2 days'), 'clarify');
  assert.equal(
    parseWhen(recurringBugText.replace(/\b(?:12\s+)?noon\b/gi, '12 pm'), 'Asia/Kolkata')?.schedule.time,
    '12:00',
  );
  assert.equal(parseSequenceCount('send 4 mails daily'), 4, 'explicit finite sequence count still wins');

  // --- test 42: single-send regression (same schedule as pre-sequence work) ---
  const singleTz = 'Asia/Kolkata';
  const singleNow = new Date('2026-08-25T05:00:00.000Z');
  const singleText = 'send the intro template to rahul tomorrow at 3pm';
  assert.equal(looksLikeSequence(singleText), false, 'single-send must not enter sequence path');
  const singleWhen = parseWhen(singleText, singleTz, singleNow);
  assert.equal(singleWhen?.schedule.frequency, 'once');
  assert.equal(singleWhen?.schedule.runAt, '2026-08-26T09:30:00.000Z');
  const singleDraft = emptyDraft();
  singleDraft.recipientHints = ['rahul'];
  singleDraft.templateHint = 'intro';
  const singleMerged = mergeInterpretation(singleDraft, {}, {
    allowActionChange: true,
    deterministicSchedule: singleWhen?.schedule,
  });
  assert.equal(singleMerged.schedule?.frequency, 'once');
  assert.equal(singleMerged.schedule?.runAt, '2026-08-26T09:30:00.000Z');
  assert.equal(singleMerged.sequenceRequested, undefined);

  // --- bare clock corrections while a once preview is open ---
  const editDraft = emptyDraft();
  editDraft.schedule = { frequency: 'once', runAt: '2023-10-05T13:00:00.000Z' };
  toCollecting(editDraft);
  const corrected = mergeInterpretation(editDraft, {}, {
    allowActionChange: false,
    deterministicSchedule: parseTimeCorrection(
      'Actually, make it 1 in afternoon',
      editDraft.schedule,
      singleTz,
      singleNow,
    )?.schedule,
  });
  assert.equal(corrected.schedule?.frequency, 'once');
  assert.equal(
    new Intl.DateTimeFormat('en-US', {
      timeZone: singleTz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    }).format(new Date(corrected.schedule!.runAt!)),
    '1:00 PM',
  );

  // --- phase 5 ambiguity guards ---
  assert.equal(isForeverSequence('send forever'), true);
  const foreverDraft = emptyDraft();
  foreverDraft.sequenceRequested = true;
  foreverDraft.sequenceSpec = { steps: [] };
  assert.equal(applySequenceCountAnswer(foreverDraft, 'forever'), 'refuse');

  const oneCountDraft = emptyDraft();
  oneCountDraft.sequenceRequested = true;
  oneCountDraft.sequenceSpec = { steps: [] };
  assert.equal(applySequenceCountAnswer(oneCountDraft, '1'), 'ok');
  assert.equal(oneCountDraft.schedule?.frequency, 'once');
  assert.equal(oneCountDraft.sequenceRequested, false);

  const overCapDraft = emptyDraft();
  overCapDraft.sequenceSpec = { steps: [] };
  assert.equal(applySequenceCountAnswer(overCapDraft, String(MAX_SEQUENCE_STEPS + 1)), 'refuse');

  assert.deepEqual(
    cleanCandidates(['14:00', '14:00', '15:00'], new Date('2026-08-21T04:30:00.000Z'), singleTz),
    ['14:00', '15:00'],
    'duplicate step-time candidates dedupe before asking',
  );

  const afterFivePm = new Date('2026-08-21T11:30:00.000Z'); // 17:00 IST
  assert.deepEqual(
    cleanCandidates(['07:00', '19:00'], afterFivePm, singleTz),
    ['19:00'],
    '"at 7" after a 5 PM step resolves to 7 PM without a question',
  );
  assert.equal(matchStepTimeCandidate('8', ['14:00', '20:00']), '20:00');
  assert.equal(matchStepTimeCandidate('2', ['14:00', '15:00']), '14:00');

  const ambMatDraft = emptyDraft();
  ambMatDraft.sequenceRequested = true;
  seedSequenceFromText(ambMatDraft, 'every 2 days');
  assert.equal(nextAmbiguity(ambMatDraft)?.kind, 'count');
  assert.equal(tryMaterializeSequenceDraft(ambMatDraft, singleTz), null, 'ambiguous drafts materialize nothing');

  const deflectCount = emptyDraft();
  deflectCount.sequenceRequested = true;
  deflectCount.sequenceSpec = { steps: [] };
  assert.equal(applySequenceCountAnswer(deflectCount, 'whatever'), 'retry', 'count deflection must not invent a number');

  const every2 = emptyDraft();
  every2.sequenceRequested = true;
  seedSequenceFromText(every2, 'every 2 days');
  assert.equal(nextAmbiguity(every2)?.kind, 'count');

  withFrozenNow('2026-08-21T00:00:00.000Z', () => {
    const anchorLabels = anchorChoiceLabels(2 * 24 * 60, 3, singleTz);
    assert.match(anchorLabels.now, /\d{4}/, 'anchor "starting today" label includes a concrete date');
    assert.match(anchorLabels.gap, /\d{4}/, 'anchor "after the first gap" label includes a concrete date');

    const anchorDraft = emptyDraft();
    anchorDraft.sequenceRequested = true;
    anchorDraft.sequenceSpec = { gapMinutes: 2 * 24 * 60, count: 3, steps: [] };
    assert.equal(nextAmbiguity(anchorDraft)?.kind, 'anchor');
    const anchorChoices = buildAnchorChoices(anchorDraft, singleTz);
    const anchorGapChoice = anchorChoices.find((c) => c.value === 'after_gap');
    assert.equal(anchorGapChoice?.label, anchorLabels.gap, 'anchor shortlist keeps the after-gap concrete date label');
    for (const choice of anchorChoices) {
      assert.match(choice.label, /\d{4}/, `anchor shortlist option "${choice.value}" carries a concrete date`);
    }
    const anchorNowChoice = anchorChoices.find((c) => c.value === 'now');
    if (anchorLabels.nowFirst && anchorLabels.nowFirst <= new Date()) {
      assert.equal(anchorNowChoice, undefined, 'anchor option 1 must not offer a past-first instant');
    } else {
      assert.equal(anchorNowChoice?.label, anchorLabels.now, 'anchor shortlist keeps the starting-today concrete date label');
    }
    assert.equal(
      Boolean(anchorNowChoice),
      Boolean(anchorLabels.nowFirst && anchorLabels.nowFirst > new Date()),
      'anchor option 1 is offered only when its first instant is still in the future',
    );
    assert.equal(tryMaterializeSequenceDraft(anchorDraft, singleTz), null, 'anchor ambiguity blocks materialization');

    const aroundRaw = extractSequenceSpecFromRaw({
      steps: [
        { spec: { kind: 'after', minutes: 0, from: 'start' } },
        { spec: { kind: 'after', minutes: 120, from: 'previous' } },
        { candidates: ['7 pm', '8 pm'] },
      ],
    });
    assert.deepEqual(aroundRaw.steps[2]?.candidates, ['19:00', '20:00'], '"around 7 or 8" parses to a 2-item shortlist');
    const around78 = emptyDraft();
    around78.sequenceRequested = true;
    around78.sequenceSpec = {
      count: 3,
      steps: aroundRaw.steps,
    };
    const around78Amb = nextAmbiguity(around78);
    assert.equal(around78Amb?.kind, 'stepTime');
    if (around78Amb?.kind === 'stepTime') {
      assert.deepEqual(around78Amb.candidates, ['19:00', '20:00'], '"around 7 or 8" stays a 2-item shortlist');
      assert.deepEqual(
        around78Amb.candidates.map(formatClockLabel),
        ['7 PM', '8 PM'],
        '"around 7 or 8" shortlist presents both clock options',
      );
    }
    assert.equal(tryMaterializeSequenceDraft(around78, singleTz), null, 'step-time ambiguity blocks materialization');
  });

  // --- chained-step fallback ---
  const userLike = 'create a 3 mails today to prakhar one now one 2 hours later and next at 5';
  assert.equal(looksLikeSequence(userLike), true);
  const chained = parseChainedSequenceSteps(userLike);
  assert.equal(chained?.length, 3);
  assert.equal(chained![0].spec?.kind, 'after');
  if (chained![0].spec?.kind === 'after') assert.equal(chained![0].spec.minutes, 0);
  if (chained![0].spec?.kind === 'after') assert.equal(chained![0].spec.from, 'start');
  if (chained![1].spec?.kind === 'after') assert.equal(chained![1].spec.minutes, 120);
  assert.ok(chained![2].candidates?.length === 2 || chained![2].spec?.kind === 'at');
  assert.deepEqual(parseChainedSequenceSteps('first now then at 5')?.[1]?.candidates, ['05:00', '17:00']);

  withFrozenNow('2026-08-21T02:30:00.000Z', () => {
    const fbDraft = emptyDraft();
    fbDraft.sequenceRequested = true;
    processSequenceDraft(fbDraft, userLike);
    const amb = nextAmbiguity(fbDraft);
    const materialized = fbDraft.schedule?.frequency === 'sequence';
    assert.ok(
      materialized || amb?.kind === 'stepTime',
      'user-like sentence must materialize or ask stepTime, not generic schedule',
    );
    if (materialized) {
      assert.equal(fbDraft.schedule?.steps?.length, 3);
      assert.equal(fbDraft.sequenceSpec, undefined, 'materialized draft clears sequenceSpec');
    }

    const llmShellDraft = emptyDraft();
    llmShellDraft.sequenceRequested = true;
    processSequenceDraft(llmShellDraft, userLike, {
      schedule: { frequency: 'sequence', steps: [{}, {}, {}] },
    });
    assert.ok(
      llmShellDraft.schedule?.steps?.length === 3
        || llmShellDraft.sequenceSpec?.steps.every(stepIsUsable),
      'empty-shell LLM steps must be replaced by deterministic fallback steps',
    );
  });

  const mismatchDraft = emptyDraft();
  mismatchDraft.sequenceRequested = true;
  mismatchDraft.sequenceSpec = {
    count: 3,
    steps: parseChainedSequenceSteps('now and 2 hours later')!,
  };
  assert.equal(mismatchDraft.sequenceSpec.steps.length, 2);
  assert.equal(
    tryMaterializeSequenceDraft(mismatchDraft, singleTz),
    null,
    'count mismatch must not materialize a short chain',
  );
  const mismatchAmb = nextAmbiguity(mismatchDraft);
  assert.equal(mismatchAmb?.kind, 'stepCountMismatch');
  if (mismatchAmb?.kind === 'stepCountMismatch') {
    assert.match(sequenceAmbiguityQuestion(mismatchAmb), /2 of 3/);
    assert.match(sequenceAmbiguityQuestion(mismatchAmb), /3rd/);
    assert.doesNotMatch(sequenceAmbiguityQuestion(mismatchAmb), /How should the sequence go/i);
  }

  const shellDraft = emptyDraft();
  shellDraft.sequenceRequested = true;
  shellDraft.sequenceSpec = {
    count: 3,
    steps: [
      { spec: { kind: 'after', minutes: 0, from: 'start' } },
      {},
      {},
    ],
  };
  applyChainedStepFallback(shellDraft, 'now one 2 hours later and next at 5');
  assert.equal(stepIsUsable(shellDraft.sequenceSpec!.steps[1]), true, 'empty shell step 2 filled by fallback');
  assert.equal(stepIsUsable(shellDraft.sequenceSpec!.steps[2]), true, 'empty shell step 3 filled by fallback');

  withFrozenNow('2026-08-21T11:30:00.000Z', () => {
    const sameDayDraft = emptyDraft();
    sameDayDraft.sequenceRequested = true;
    sameDayDraft.sequenceSpec = {
      count: 3,
      sameDay: true,
      steps: [
        { spec: { kind: 'after', minutes: 0, from: 'start' } },
        { spec: { kind: 'after', minutes: 120, from: 'previous' } },
        { spec: { kind: 'at', time: '17:00', dayOffset: 0 } },
      ],
    };
    assert.equal(tryMaterializeSequenceDraft(sameDayDraft, singleTz), null, 'sameDay late chain must not materialize');
    const sameDayAmb = nextAmbiguity(sameDayDraft);
    assert.equal(sameDayAmb?.kind, 'sameDayConflict');
    if (sameDayAmb?.kind === 'sameDayConflict') {
      assert.match(sequenceAmbiguityQuestion(sameDayAmb), /after midnight/i);
      assert.doesNotMatch(sequenceAmbiguityQuestion(sameDayAmb), /How should the sequence go/i);
    }
  });

  const stepTplMocks: TemplateRecord[] = [
    { id: 'intro', name: 'Introduction', description: '' },
    { id: 'follow1', name: 'Follow-up 1', description: 'follow up note' },
    { id: 'follow2', name: 'Quotation Follow-up', description: '' },
  ];
  const stepTplUnique: TemplateRecord[] = [
    { id: 'intro', name: 'Introduction', description: '' },
    { id: 'follow1', name: 'Follow-up 1', description: '' },
    { id: 'closing', name: 'Closing Note', description: '' },
  ];
  const perStepText =
    'for first mail use introduction for second use followup and for last use again introduction';
  const perStepHints = parsePerStepTemplateHints(perStepText, 3);
  assert.equal(perStepHints.length, 3);
  assert.equal(perStepHints[0].hint, 'introduction');
  assert.equal(perStepHints[1].hint, 'followup');
  assert.equal(perStepHints[2].hint, 'introduction');
  assert.deepEqual(perStepHints.map((hint) => hint.index), [0, 1, 2], 'template hints keep user-stated step order');
  const perStepDraft = emptyDraft();
  perStepDraft.sequenceRequested = true;
  perStepDraft.sequenceSpec = { count: 3, steps: [{}, {}, {}] };
  assert.equal(applyPerStepTemplateHints(perStepDraft, perStepText, stepTplUnique), null);
  assert.equal(perStepDraft.sequenceSpec!.steps[0].templateId, 'intro');
  assert.equal(perStepDraft.sequenceSpec!.steps[1].templateId, 'follow1');
  assert.equal(perStepDraft.sequenceSpec!.steps[2].templateId, 'intro');
  const materializedPerStepDraft = emptyDraft();
  materializedPerStepDraft.sequenceRequested = true;
  materializedPerStepDraft.schedule = validSeq!;
  assert.equal(applyPerStepTemplateHints(materializedPerStepDraft, perStepText, stepTplUnique), null);
  const rematerializedPerStep = tryMaterializeSequenceDraft(materializedPerStepDraft, singleTz);
  assert.deepEqual(
    rematerializedPerStep?.steps?.map((step) => step.templateId),
    ['intro', 'follow1', 'intro'],
    'per-step directives override a sequence already materialized from the LLM',
  );
  assert.equal(
    rematerializedPerStep?.startAt,
    validSeq!.startAt,
    'template edits on a materialized sequence keep the original startAt',
  );
  const ambTpl = matchTemplatesForStepHint('followup', stepTplMocks, 1);
  assert.equal(ambTpl.kind, 'choices');
  if (ambTpl.kind === 'choices') {
    assert.equal(ambTpl.choices.length, 2);
    assert.match(ambTpl.choices[0].id, /^stepTemplate:1:/);
  }
  const ambStepDraft = emptyDraft();
  ambStepDraft.sequenceSpec = { count: 3, steps: [{ templateId: 'intro' }, {}, {}] };
  const ambStep = applyPerStepTemplateHints(ambStepDraft, perStepText, stepTplMocks);
  assert.equal(ambStep?.kind, 'stepTemplate');
  if (ambStep?.kind === 'stepTemplate') {
    assert.equal(ambStep.stepIndex, 1);
    assert.match(sequenceAmbiguityQuestion(ambStep), /multiple templates for followup on step 2/i);
    assert.match(sequenceAmbiguityQuestion(ambStep), /Follow-up 1/);
  }

  // --- the reported loop: "one now / one 2 hours later / one at 5" carries its own count ---
  const chainBugText =
    'send mail to prakhar one right now one 2 hours later one at 5 in evening '
    + 'and for first mail use introduction template for rest use follow up';
  assert.equal(parseSequenceCount(chainBugText), null, 'the sentence names no numeric count');
  assert.equal(parseChainMarkerCount(chainBugText), 3, 'three explicit step markers mean three sends');
  assert.equal(looksLikeSequence(chainBugText), true);

  const inlineTemplateText =
    'create a sequence for prakhar send one introduction mail now then follow up mail daily at 12 noon';
  const inlineHints = parsePerStepTemplateHints(inlineTemplateText, 2);
  assert.deepEqual(
    inlineHints.map((h) => h.index),
    [0, 1],
    'chained inline template hints map to step order',
  );
  assert.deepEqual(
    inlineHints.map((h) => h.hint),
    ['introduction', 'follow up'],
    'inline template names are preserved for per-step resolution',
  );
  const inlineStepDraft = emptyDraft();
  inlineStepDraft.sequenceRequested = true;
  inlineStepDraft.sequenceSpec = { count: 2, steps: [{}, {}] };
  assert.equal(applyPerStepTemplateHints(inlineStepDraft, inlineTemplateText, stepTplUnique), null);
  assert.deepEqual(
    inlineStepDraft.sequenceSpec!.steps.map((s) => s.templateId),
    ['intro', 'follow1'],
    'inline chained directives resolve a different template for each send',
  );
  const correctionStepDraft = emptyDraft();
  correctionStepDraft.sequenceRequested = true;
  correctionStepDraft.sequenceSpec = { count: 2, steps: [{ templateId: 'intro' }, { templateId: 'intro' }] };
  assert.equal(
    applyPerStepTemplateHints(
      correctionStepDraft,
      'make it introduction in first only in second use followup',
      stepTplUnique,
    ),
    null,
  );
  assert.deepEqual(
    correctionStepDraft.sequenceSpec!.steps.map((s) => s.templateId),
    ['intro', 'follow1'],
    'explicit step-template correction overrides an earlier step template assignment',
  );

  const chainSeed = emptyDraft();
  chainSeed.sequenceRequested = true;
  seedSequenceFromText(chainSeed, chainBugText);
  assert.equal(chainSeed.sequenceSpec?.count, 3, 'the marker chain seeds the count');
  assert.equal(chainSeed.sequenceSpec?.steps.length, 3);
  const afterFirstStep = parseChainedSequenceSteps('add one 2 hours after first one');
  assert.equal(afterFirstStep?.[0]?.spec?.kind, 'after', '"2 hours after first one" parses as a relative step');
  if (afterFirstStep?.[0]?.spec?.kind === 'after') assert.equal(afterFirstStep[0].spec.minutes, 120);

  const addMoreDraft = emptyDraft();
  addMoreDraft.templateId = 'intro';
  addMoreDraft.schedule = { frequency: 'once', runAt: '2026-08-22T07:30:00.000Z' };
  assert.equal(
    applyAddMoreSequenceIntent(addMoreDraft, 'add 2 more mails one 2 hours after first one'),
    true,
    '"add N more" is treated as extending an existing draft, not replacing it',
  );
  assert.equal(addMoreDraft.schedule, undefined, 'add-more conversion moves once schedule into sequenceSpec');
  assert.equal(addMoreDraft.sequenceSpec?.startAt, '2026-08-22T07:30:00.000Z');
  assert.equal(addMoreDraft.sequenceSpec?.count, 3, 'existing one-time send plus 2 more => 3 total');
  assert.equal(addMoreDraft.sequenceSpec?.steps[0]?.spec?.kind, 'after');
  assert.equal(addMoreDraft.sequenceSpec?.steps[1]?.spec?.kind, 'after');
  if (addMoreDraft.sequenceSpec?.steps[1]?.spec?.kind === 'after') {
    assert.equal(addMoreDraft.sequenceSpec.steps[1].spec.minutes, 120);
  }
  assert.notEqual(nextAmbiguity(addMoreDraft)?.kind, 'count', '"add more" should not ask again for total send count');

  withFrozenNow('2026-08-21T02:30:00.000Z', () => {
    const chainDraft = emptyDraft();
    chainDraft.sequenceRequested = true;
    processSequenceDraft(chainDraft, chainBugText);
    const chainAmb = nextAmbiguity(chainDraft);
    assert.notEqual(chainAmb?.kind, 'count', 'the marker chain must never re-ask "how many sends"');
    assert.notEqual(chainAmb?.kind, 'stepCountMismatch', 'all three steps parse out of the chain');
    assert.ok(
      chainDraft.schedule?.frequency === 'sequence' || chainAmb?.kind === 'stepTime',
      'the sentence materializes or asks which 5 o clock — never a generic count',
    );

    const chainShellDraft = emptyDraft();
    chainShellDraft.sequenceRequested = true;
    processSequenceDraft(chainShellDraft, chainBugText, {
      schedule: { frequency: 'sequence', steps: [{}, {}, {}] },
    });
    assert.notEqual(nextAmbiguity(chainShellDraft)?.kind, 'count', 'empty-shell LLM steps still keep the count');
    assert.ok(
      chainShellDraft.schedule?.steps?.length === 3
        || chainShellDraft.sequenceSpec?.steps.every(stepIsUsable),
      'empty-shell LLM steps are filled by the deterministic chain, not left as placeholders',
    );
  });

  const explicitOverMarkers = emptyDraft();
  explicitOverMarkers.sequenceRequested = true;
  seedSequenceFromText(explicitOverMarkers, 'send 2 mails one now one 2 hours later one at 5');
  assert.equal(explicitOverMarkers.sequenceSpec?.count, 2, 'an explicit "2 mails" outranks 3 markers');

  for (const prose of [
    'send the intro template to rahul tomorrow at 3pm',
    'one of our leads wants a quote now',
    'no one now and no one later',
    'i will send one now',
  ]) {
    assert.equal(parseChainMarkerCount(prose), null, `prose must not infer a count: ${prose}`);
  }

  // --- "for first ... for rest ..." assigns a template per step ---
  const restHints = parsePerStepTemplateHints(chainBugText, 3);
  assert.deepEqual(restHints.map((h) => h.index), [0, 1, 2], '"rest" covers every unclaimed step');
  assert.deepEqual(
    restHints.map((h) => h.hint),
    ['introduction', 'follow up', 'follow up'],
    'partial template names survive the directive split',
  );

  const restUnique = emptyDraft();
  restUnique.sequenceRequested = true;
  restUnique.sequenceSpec = { count: 3, steps: [{}, {}, {}] };
  assert.equal(applyPerStepTemplateHints(restUnique, chainBugText, stepTplUnique), null);
  assert.deepEqual(
    restUnique.sequenceSpec!.steps.map((s) => s.templateId),
    ['intro', 'follow1', 'follow1'],
    'a unique partial resolves for both the named step and the rest',
  );
  assert.equal(matchTemplatesForStepHint('INTRO', stepTplUnique, 0).kind, 'single');
  const upperFollow = matchTemplatesForStepHint('Follow Up', stepTplUnique, 1);
  assert.equal(upperFollow.kind, 'single', 'partial matching ignores case and hyphens');
  if (upperFollow.kind === 'single') assert.equal(upperFollow.id, 'follow1');

  const restAmbDraft = emptyDraft();
  restAmbDraft.sequenceRequested = true;
  restAmbDraft.sequenceSpec = { count: 3, steps: [{}, {}, {}] };
  const restAmb = applyPerStepTemplateHints(restAmbDraft, chainBugText, stepTplMocks);
  assert.equal(restAmb?.kind, 'stepTemplate', '"follow up" matching two templates must ask, not guess');
  if (restAmb?.kind === 'stepTemplate') {
    assert.equal(restAmb.stepIndex, 1);
    assert.equal(restAmb.choices.length, 2);
    assert.match(restAmb.choices[0].id, /^stepTemplate:1:/);
    assert.match(sequenceAmbiguityQuestion(restAmb), /Follow-up 1/);
  }
  assert.equal(
    restAmbDraft.sequenceSpec!.steps[0].templateId,
    'intro',
    'the unambiguous step stays resolved while the ambiguous one is asked about',
  );

  const at5AmbDraft = emptyDraft();
  at5AmbDraft.sequenceRequested = true;
  at5AmbDraft.sequenceSpec = {
    count: 2,
    steps: [
      { spec: { kind: 'after', minutes: 0, from: 'start' } },
      { candidates: ['05:00', '17:00'] },
    ],
  };
  withFrozenNow('2026-08-20T22:30:00.000Z', () => {
    const at5Amb = nextAmbiguity(at5AmbDraft);
    assert.equal(at5Amb?.kind, 'stepTime');
    if (at5Amb?.kind === 'stepTime') {
      assert.deepEqual(at5Amb.candidates, ['05:00', '17:00'], 'bare "at 5" keeps AM/PM candidates when both are clean');
    }
  });

  const createFlowSource = handleCreateDraft.toString();
  const ambiguityCheckAt = createFlowSource.indexOf('nextAmbiguity(draft)');
  const previewBuildAt = createFlowSource.indexOf('buildDraftPreview');
  assert.ok(ambiguityCheckAt >= 0 && previewBuildAt >= 0, 'create flow includes ambiguity and preview branches');
  assert.ok(
    ambiguityCheckAt < previewBuildAt,
    'create flow checks ambiguity before the preview build path',
  );
  const beforePreviewSource = createFlowSource.slice(ambiguityCheckAt, previewBuildAt);
  assert.match(beforePreviewSource, /choices\s*:/, 'ambiguous create branch returns shortlist choices');
  assert.match(beforePreviewSource, /return\s*\{/, 'ambiguous create branch returns before preview build');
  assert.equal(
    beforePreviewSource.includes('buildDraftPreview'),
    false,
    'ambiguous create branch must not build preview',
  );

  assert.equal(
    mergeInterpretation(emptyDraft(), {}, {
      allowActionChange: true,
      deterministicSchedule: validSeq,
    }).schedule,
    undefined,
    'deterministic sequence without sequenceRequested stays stripped',
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
  for (const t of ['make it 3pm', 'change it to Monday at 10am', 'send it tomorrow', 'change the time', 'Actually, make it 1 in afternoon', '1 pm']) {
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
