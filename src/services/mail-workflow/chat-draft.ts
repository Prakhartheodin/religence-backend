import assert from 'node:assert/strict';
import type { StepSpec, WorkflowAction, WorkflowSchedule } from './contract.js';

export type RawStep = {
  spec?: StepSpec;
  /** More than one when the phrasing admits several clocks ("around 7 or 8"). */
  candidates?: string[];
  templateId?: string;
};

export type SequenceSpec = {
  /** Fixed base instant when editing an existing once/sequence draft. */
  startAt?: string;
  anchor?: 'now' | 'after_gap';
  count?: number;
  sameDay?: boolean;
  steps: RawStep[];
  /** Parsed from "every N days" when count is still unknown. */
  gapMinutes?: number;
};

export type Ambiguity =
  | { kind: 'count' }
  | { kind: 'anchor'; gapMinutes: number; count: number }
  | { kind: 'stepTime'; stepIndex: number; candidates: string[] }
  | { kind: 'stepCountMismatch'; parsed: number; expected: number; missingSteps: number[] }
  | { kind: 'sameDayConflict'; stepIndex: number }
  | { kind: 'stepTemplate'; stepIndex: number; hint: string; choices: DraftChoice[] };

export type DraftChoice = {
  id: string;
  label: string;
  sublabel?: string;
  field: 'templateId' | 'recipientId' | 'anchor' | 'stepTime' | 'stepTemplate';
  value: string;
};

/**
 * Authoritative conversation state. The LLM extracts intent and data; only the functions
 * in this file move the conversation between states. An LLM reply can never transition it.
 *
 *   IDLE ──describe a send──▶ COLLECTING_CREATE ──all fields──▶ AWAITING_CONFIRMATION
 *     ▲                            │   ▲                              │
 *     └────── cancel / done ───────┘   └────── edit ──────────────────┤
 *                                                                     │
 *                                             confirm ────────────────┘ (workflow ACTIVE)
 */
export type ChatState = 'idle' | 'collecting_create' | 'awaiting_confirmation';

export type DraftStep =
  | 'recipient'
  | 'schedule'
  | 'template'
  | 'variables'
  | 'confirmation'
  | 'complete';

export type MissingField = 'recipients' | 'schedule' | 'template' | 'variables';
export type ExecutionMode = 'recurring' | 'once';

export type ConversationDraft = {
  state: ChatState;
  action: WorkflowAction;
  executionMode?: ExecutionMode;
  templateId?: string;
  templateHint?: string;
  recipientIds: string[];
  recipientHints: string[];
  schedule?: WorkflowSchedule;
  variables: Record<string, string>;
  workflowId?: string;
  workflowHint?: string;
  pendingChoices?: DraftChoice[];
  /** Which confirmation is outstanding. Only meaningful in `awaiting_confirmation`. */
  awaitingConfirmation?: 'create' | 'update' | 'pause' | 'resume' | 'cancel';
  confirmationWorkflowId?: string;
  /**
   * Minted when a preview is shown and reused by every confirmation path (button and
   * natural language) so a double-click or retry cannot create a second workflow.
   */
  confirmRequestId?: string;
  /**
   * The request described several sends, so the schedule question asks for steps rather
   * than a single time. Genuine state — it comes from the original message, which is not
   * persisted, so it cannot be derived the way missingFields can.
   */
  sequenceRequested?: boolean;
  /** Un-materialized sequence intent while ambiguity is resolved. */
  sequenceSpec?: SequenceSpec;
  currentStep?: DraftStep;
  missingFields?: MissingField[];
  /**
   * Which field the last deterministic question was about, and how many times in a row we
   * have asked. Drives escalating wording. Deliberately NOT a `pendingField` — that is
   * always `computeMissingFields()[0]` and a stored copy could only drift from it.
   */
  askedField?: MissingField | null;
  askedCount?: number;
};

export function emptyDraft(): ConversationDraft {
  return refreshDraftSteps({
    state: 'idle',
    action: 'create',
    executionMode: 'recurring',
    recipientIds: [],
    recipientHints: [],
    variables: {},
  });
}

export function isOnceDraft(draft: ConversationDraft): boolean {
  return draft.schedule?.frequency === 'once' || draft.executionMode === 'once';
}

/**
 * A field is satisfied only by a RESOLVED value. An unmatched hint like "xyzabc" used to
 * count as an answer, so the flow moved on to schedule and template and only reported the
 * failure three questions later. Hints are a lead, not an answer.
 */
export function computeMissingFields(
  draft: ConversationDraft,
  variableNamesMissing?: string[] | null,
): MissingField[] {
  if (draft.action !== 'create') return [];
  const missing: MissingField[] = [];
  if (!draft.recipientIds.length) missing.push('recipients');
  if (!draft.schedule) missing.push('schedule');
  if (!draft.templateId) missing.push('template');
  // Variables are resolved against the chosen template, which needs an async load, so the
  // caller passes the answer in rather than this staying pure-but-wrong.
  if (variableNamesMissing?.length) missing.push('variables');
  return missing;
}

/** Everything needed to build a contract is resolved (hints do not count). */
export function draftIsComplete(draft: ConversationDraft): boolean {
  return Boolean(draft.templateId) && draft.recipientIds.length > 0 && Boolean(draft.schedule);
}

export function computeCurrentStep(
  draft: ConversationDraft,
  variableNamesMissing?: string[] | null,
): DraftStep {
  if (draft.state === 'awaiting_confirmation') return 'confirmation';
  if (draft.action !== 'create') return 'complete';

  const missing = computeMissingFields(draft, variableNamesMissing);
  if (missing.includes('recipients')) return 'recipient';
  if (missing.includes('schedule')) return 'schedule';
  if (missing.includes('template')) return 'template';
  if (missing.includes('variables')) return 'variables';
  return draftIsComplete(draft) ? 'complete' : 'recipient';
}

/**
 * Records that we just asked about `field` and returns how many times in a row we have.
 * Two scalars, not a per-field map: only the first missing field is ever asked about, so
 * at most one counter is live. This is what stops the identical sentence repeating.
 */
export function noteAsked(draft: ConversationDraft, field: MissingField): number {
  draft.askedCount = draft.askedField === field ? (draft.askedCount ?? 0) + 1 : 1;
  draft.askedField = field;
  return draft.askedCount;
}

/** Progress was made — the next question about a new field starts from tier 1 again. */
export function clearAsked(draft: ConversationDraft): void {
  draft.askedField = null;
  draft.askedCount = 0;
}

export function refreshDraftSteps(
  draft: ConversationDraft,
  variableNamesMissing?: string[] | null,
): ConversationDraft {
  // Keep `state` consistent with the data even if an older session document predates it.
  if (!draft.state) {
    draft.state = draft.awaitingConfirmation
      ? 'awaiting_confirmation'
      : draftHasAnyInput(draft)
        ? 'collecting_create'
        : 'idle';
  }
  if (draft.state === 'awaiting_confirmation' && !draft.awaitingConfirmation) {
    draft.state = draftHasAnyInput(draft) ? 'collecting_create' : 'idle';
  }
  draft.missingFields = computeMissingFields(draft, variableNamesMissing);
  draft.currentStep = computeCurrentStep(draft, variableNamesMissing);
  return draft;
}

export function draftHasAnyInput(draft: ConversationDraft): boolean {
  return Boolean(
    draft.templateId
    || draft.templateHint
    || draft.recipientIds.length
    || draft.recipientHints.length
    || draft.schedule
    || draft.workflowId
    || draft.workflowHint
    || draft.pendingChoices?.length
    || draft.sequenceRequested
    || draft.sequenceSpec,
  );
}

/** Safe to reset to the welcome message: nothing collected, nothing outstanding. */
export function draftIsIdle(draft: ConversationDraft): boolean {
  return draft.state === 'idle' && !draft.awaitingConfirmation && !draftHasAnyInput(draft);
}

// --- transitions (the only sanctioned way to change state) -------------------

export function toCollecting(draft: ConversationDraft): ConversationDraft {
  draft.state = 'collecting_create';
  draft.action = 'create';
  draft.awaitingConfirmation = undefined;
  draft.confirmationWorkflowId = undefined;
  // The token belongs to the card that is currently on screen. Leaving confirmation for
  // ANY reason retires it, so a freshly built preview always supersedes the old one
  // rather than inheriting its identity.
  draft.confirmRequestId = undefined;
  return refreshDraftSteps(draft);
}

export function toAwaitingCreateConfirmation(
  draft: ConversationDraft,
  confirmRequestId: string,
): ConversationDraft {
  draft.state = 'awaiting_confirmation';
  draft.awaitingConfirmation = 'create';
  // Mint once and keep it: every confirmation attempt reuses this id.
  draft.confirmRequestId = draft.confirmRequestId ?? confirmRequestId;
  return refreshDraftSteps(draft);
}

export function toAwaitingUpdateConfirmation(
  draft: ConversationDraft,
  workflowId: string,
  confirmRequestId: string,
): ConversationDraft {
  draft.state = 'awaiting_confirmation';
  draft.action = 'update';
  draft.workflowId = workflowId;
  draft.awaitingConfirmation = 'update';
  draft.confirmationWorkflowId = workflowId;
  draft.confirmRequestId = draft.confirmRequestId ?? confirmRequestId;
  return refreshDraftSteps(draft);
}

export function toAwaitingManagementConfirmation(
  action: 'pause' | 'resume' | 'cancel',
  workflowId: string,
  confirmRequestId: string,
): ConversationDraft {
  const draft = emptyDraft();
  draft.state = 'awaiting_confirmation';
  draft.action = action;
  draft.workflowId = workflowId;
  draft.awaitingConfirmation = action;
  draft.confirmationWorkflowId = workflowId;
  draft.confirmRequestId = confirmRequestId;
  return refreshDraftSteps(draft);
}

/** Leave confirmation and go back to editing the same draft — never a new workflow. */
export function toEditing(draft: ConversationDraft): ConversationDraft {
  draft.state = 'collecting_create';
  draft.awaitingConfirmation = undefined;
  draft.confirmationWorkflowId = undefined;
  // Drop the confirm id: the edited draft is a different thing and needs a fresh one.
  draft.confirmRequestId = undefined;
  return refreshDraftSteps(draft);
}

export function isActiveCreateFlow(draft: ConversationDraft): boolean {
  return draft.action === 'create' && draft.state === 'collecting_create';
}

export function needsCreateStepRouting(draft: ConversationDraft): boolean {
  if (!isActiveCreateFlow(draft)) return false;
  const step = refreshDraftSteps(draft).currentStep;
  return step === 'recipient' || step === 'schedule' || step === 'template' || step === 'variables';
}

if (process.argv[1]?.endsWith('chat-draft.ts')) {
  let d = emptyDraft();
  assert.equal(d.state, 'idle');
  assert.equal(d.currentStep, 'recipient');
  assert.equal(draftIsIdle(d), true);

  d.recipientIds = ['lead-1'];
  toCollecting(d);
  assert.equal(d.state, 'collecting_create');
  assert.equal(d.currentStep, 'schedule');
  assert.equal(draftIsIdle(d), false);

  d.schedule = { frequency: 'daily', time: '14:00' };
  refreshDraftSteps(d);
  assert.equal(d.currentStep, 'template');
  d.templateId = 'tpl-1';
  refreshDraftSteps(d);
  assert.equal(d.currentStep, 'complete');
  assert.equal(draftIsComplete(d), true);

  // once is a schedule like any other — it does not skip the schedule question
  const onceDraft = emptyDraft();
  onceDraft.recipientIds = ['lead-1'];
  onceDraft.templateId = 'tpl-1';
  refreshDraftSteps(onceDraft);
  assert.equal(onceDraft.currentStep, 'schedule', 'a one-time send still needs a when');
  onceDraft.schedule = { frequency: 'once', runAt: new Date().toISOString() };
  refreshDraftSteps(onceDraft);
  assert.equal(onceDraft.currentStep, 'complete');
  assert.equal(isOnceDraft(onceDraft), true);

  // confirmation id is minted once and survives repeated transitions
  toAwaitingCreateConfirmation(onceDraft, 'req-1');
  assert.equal(onceDraft.state, 'awaiting_confirmation');
  assert.equal(onceDraft.currentStep, 'confirmation');
  toAwaitingCreateConfirmation(onceDraft, 'req-2');
  assert.equal(onceDraft.confirmRequestId, 'req-1', 'confirm id must be stable');

  // editing returns to collecting and invalidates the confirm id
  toEditing(onceDraft);
  assert.equal(onceDraft.state, 'collecting_create');
  assert.equal(onceDraft.awaitingConfirmation, undefined);
  assert.equal(onceDraft.confirmRequestId, undefined);

  // ...and so does any other route back to collecting, so a rebuilt preview can never
  // inherit the token of the card still sitting on screen above it.
  const reCollect = emptyDraft();
  toAwaitingCreateConfirmation(reCollect, 'req-token');
  assert.equal(reCollect.confirmRequestId, 'req-token');
  toCollecting(reCollect);
  assert.equal(reCollect.confirmRequestId, undefined, 'leaving confirmation retires the card token');

  // --- an unresolved hint is a lead, not an answer ---
  const hinted = emptyDraft();
  hinted.recipientHints = ['xyzabc'];
  hinted.action = 'create';
  assert.deepEqual(
    computeMissingFields(hinted),
    ['recipients', 'schedule', 'template'],
    'an unmatched recipient hint must not satisfy recipients',
  );
  hinted.templateHint = 'follow up';
  assert.equal(
    computeMissingFields(hinted).includes('template'),
    true,
    'an unmatched template hint must not satisfy template',
  );
  hinted.recipientIds = ['lead-1'];
  hinted.templateId = 'tpl-1';
  assert.deepEqual(computeMissingFields(hinted), ['schedule'], 'resolved ids do satisfy');

  // --- variables are a real missing field, fed in from the async template load ---
  const varDraft = emptyDraft();
  varDraft.recipientIds = ['lead-1'];
  varDraft.templateId = 'tpl-1';
  varDraft.schedule = { frequency: 'daily', time: '10:00' };
  assert.deepEqual(computeMissingFields(varDraft), []);
  assert.deepEqual(computeMissingFields(varDraft, ['qty']), ['variables']);
  refreshDraftSteps(varDraft, ['qty']);
  assert.equal(varDraft.currentStep, 'variables');
  refreshDraftSteps(varDraft, null);
  assert.equal(varDraft.currentStep, 'complete');

  // --- ask counter: repeats escalate, a new field resets ---
  const asked = emptyDraft();
  assert.equal(noteAsked(asked, 'recipients'), 1);
  assert.equal(noteAsked(asked, 'recipients'), 2);
  assert.equal(noteAsked(asked, 'recipients'), 3);
  assert.equal(noteAsked(asked, 'schedule'), 1, 'a different field starts over');
  assert.equal(asked.askedField, 'schedule');
  clearAsked(asked);
  assert.equal(asked.askedField, null);
  assert.equal(noteAsked(asked, 'schedule'), 1, 'clearing resets the streak');

  // a stale doc without `state` is repaired, not trusted blindly
  const legacy = { ...emptyDraft(), state: undefined as unknown as ChatState, recipientIds: ['x'] };
  refreshDraftSteps(legacy);
  assert.equal(legacy.state, 'collecting_create');

  const mgmt = toAwaitingManagementConfirmation('pause', 'wf-1', 'req-9');
  assert.equal(mgmt.state, 'awaiting_confirmation');
  assert.equal(mgmt.action, 'pause');
  assert.equal(mgmt.confirmationWorkflowId, 'wf-1');

  console.log('chat-draft self-check passed');
}
