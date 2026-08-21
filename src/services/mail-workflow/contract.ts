export const CONTRACT_VERSION = 'v1' as const;
export const CONFIDENCE_MIN = 0.7;
export const MAX_RECIPIENTS = 50;
export const CRM_MERGE_KEYS = [
  'company_name', 'contact_name', 'salt_name', 'medicine_name', 'dosage_form', 'sender_name',
] as const;

export type WorkflowAction = 'create' | 'update' | 'pause' | 'resume' | 'cancel' | 'list';

export type WorkflowStatus =
  | 'draft_requires_auth'
  | 'pending_confirm'
  | 'active'
  | 'paused'
  | 'paused_auth_required'
  | 'completed'
  | 'cancelled';

/** Run-level outcome. `unknown` = provider outcome could not be determined; needs a human. */
export type RunStatus =
  | 'running'
  | 'success'
  | 'partial_success'
  | 'failed'
  | 'skipped'
  | 'unknown';

/**
 * Per-occurrence send state machine. Persisted so a crashed worker can decide whether
 * a retry is safe rather than blindly resending.
 */
export type SendState =
  | 'scheduled'
  | 'sending'
  | 'provider_accepted'
  | 'succeeded'
  | 'failed'
  | 'unknown_provider_outcome';

export type RecipientSendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';

/** `once` is a first-class frequency, not maxRuns=1 in disguise. */
export type Frequency = 'once' | 'daily' | 'weekly' | 'monthly' | 'sequence';
export type ExecutionMode = 'recurring' | 'once';

/** How one step in a sequence is timed. */
export type StepSpec =
  /** Relative: "after 1 hour", "3 days later". */
  | { kind: 'after'; minutes: number; from: 'start' | 'previous' }
  /** Absolute wall clock in the workflow timezone: "at 2pm", "9am on day 3". */
  | { kind: 'at'; time: string; dayOffset: number };

export type SequenceStep = {
  spec: StepSpec;
  /** Materialized ISO-8601 UTC instant. The scheduler reads only this. */
  at: string;
  /** Absent = inherit the workflow's templateId. */
  templateId?: string;
};

export type WorkflowSchedule = {
  frequency: Frequency;
  /** HH:mm in the workspace timezone. Absent for `once` (runAt carries the instant). */
  time?: string;
  /** ISO-8601 UTC instant. Required when frequency === 'once'. */
  runAt?: string;
  dayOfWeek?: number; // weekly ISO 1–7
  dayOfMonth?: number; // monthly 1–31
  endDate?: string; // YYYY-MM-DD
  maxRuns?: number;
  /** sequence only: the anchor the steps were materialized from. Never moves. */
  startAt?: string;
  /** sequence only: ordered, materialized steps. */
  steps?: SequenceStep[];
};

export type WorkflowCommandContractV1 = {
  version: 'v1';
  action: WorkflowAction;
  /** Derived from schedule.frequency. Kept for wire compatibility with existing clients. */
  executionMode?: ExecutionMode;
  /** Legacy alias for schedule.runAt. Kept for wire compatibility. */
  oneTimeSendAt?: string;
  workflowId?: string;
  templateId?: string;
  recipientIds?: string[];
  schedule?: WorkflowSchedule;
  variables?: Record<string, string>;
  confidence: number;
  requestId: string;
};

export class WorkflowError extends Error {
  constructor(
    public code:
      | 'RECIPIENT_NOT_FOUND'
      | 'TEMPLATE_MISSING'
      | 'TEMPLATE_VARS_MISSING'
      | 'AUTH_REQUIRED'
      | 'SCHEDULE_INVALID'
      | 'WORKFLOW_NOT_FOUND'
      | 'AMBIGUOUS_WORKFLOW'
      | 'CONFIRMATION_REQUIRED'
      | 'CONTRACT_INVALID',
    message: string,
    public httpStatus = 400
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

import { randomUUID } from 'node:crypto';

const ACTIONS = new Set(['create', 'update', 'pause', 'resume', 'cancel', 'list']);
const FREQ = new Set(['once', 'daily', 'weekly', 'monthly', 'sequence']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_SEQUENCE_STEPS = 20;
export const MIN_STEP_GAP_MINUTES = 5;
export const MAX_SEQUENCE_SPAN_DAYS = 365;

export function isOnceSchedule(s: WorkflowSchedule | undefined): boolean {
  return s?.frequency === 'once';
}

export function executionModeOf(s: WorkflowSchedule | undefined): ExecutionMode {
  return isOnceSchedule(s) ? 'once' : 'recurring';
}

function parseIsoInstant(value: unknown, field: string): string {
  const raw = String(value ?? '').trim();
  const dt = new Date(raw);
  if (!raw || Number.isNaN(dt.getTime())) {
    throw new WorkflowError('SCHEDULE_INVALID', `${field} must be a valid ISO datetime`);
  }
  return dt.toISOString();
}

/** Policy bounds for sequences — shared by API and confirm paths. Structure lives in parseSchedule. */
export function validateSequencePolicy(schedule: WorkflowSchedule): void {
  if (schedule.frequency !== 'sequence') return;
  const steps = schedule.steps ?? [];
  if (steps.length < 2) {
    throw new WorkflowError('SCHEDULE_INVALID', 'a sequence needs at least two steps');
  }
  if (steps.length > MAX_SEQUENCE_STEPS) {
    throw new WorkflowError('SCHEDULE_INVALID', `a sequence may have at most ${MAX_SEQUENCE_STEPS} steps`);
  }
  const startAt = new Date(schedule.startAt ?? '');
  if (!schedule.startAt || Number.isNaN(startAt.getTime())) {
    throw new WorkflowError('SCHEDULE_INVALID', 'schedule.startAt must be a valid ISO datetime');
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.spec.kind === 'after' && step.spec.from !== 'start' && step.spec.from !== 'previous') {
      throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].spec.from must be 'start' or 'previous'`);
    }
    if (i === 0) continue;
    const prev = new Date(steps[i - 1].at);
    const cur = new Date(steps[i].at);
    if (cur <= prev) {
      throw new WorkflowError('SCHEDULE_INVALID', 'sequence steps must be strictly increasing');
    }
    if (cur.getTime() - prev.getTime() < MIN_STEP_GAP_MINUTES * 60_000) {
      throw new WorkflowError(
        'SCHEDULE_INVALID',
        `steps must be at least ${MIN_STEP_GAP_MINUTES} minutes apart`,
      );
    }
  }
  const spanMs = new Date(steps[steps.length - 1].at).getTime() - startAt.getTime();
  if (spanMs > MAX_SEQUENCE_SPAN_DAYS * 24 * 60 * 60 * 1000) {
    throw new WorkflowError(
      'SCHEDULE_INVALID',
      `a sequence may span at most ${MAX_SEQUENCE_SPAN_DAYS} days`,
    );
  }
}

function parseSchedule(raw: unknown): WorkflowSchedule {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    throw new WorkflowError('SCHEDULE_INVALID', 'schedule must be object');
  }
  const s = raw as Record<string, unknown>;
  const frequency = String(s.frequency ?? '').trim().toLowerCase();
  if (!FREQ.has(frequency)) throw new WorkflowError('SCHEDULE_INVALID', 'invalid frequency');

  if (frequency === 'once') {
    return { frequency: 'once', runAt: parseIsoInstant(s.runAt, 'schedule.runAt') };
  }

  if (frequency === 'sequence') {
    const rawSteps = Array.isArray(s.steps) ? s.steps : [];
    if (!rawSteps.length) {
      throw new WorkflowError('SCHEDULE_INVALID', 'a sequence needs at least one step');
    }
    const steps: SequenceStep[] = rawSteps.map((entry, i) => {
      const step = entry as Record<string, unknown>;
      const at = parseIsoInstant(step.at, `schedule.steps[${i}].at`);
      const rawSpec = (step.spec ?? {}) as Record<string, unknown>;
      const kind = String(rawSpec.kind ?? '');
      let spec: StepSpec;
      if (kind === 'after') {
        const minutes = Number(rawSpec.minutes);
        if (!Number.isInteger(minutes) || minutes < 0) {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].minutes must be an integer >= 0`);
        }
        const from = String(rawSpec.from ?? '');
        if (from !== 'start' && from !== 'previous') {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].spec.from must be 'start' or 'previous'`);
        }
        spec = { kind: 'after', minutes, from };
      } else if (kind === 'at') {
        const time = String(rawSpec.time ?? '');
        if (!HHMM.test(time)) {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].time must be HH:mm`);
        }
        const dayOffset = Number(rawSpec.dayOffset ?? 0);
        if (!Number.isInteger(dayOffset) || dayOffset < 0) {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].dayOffset must be >= 0`);
        }
        spec = { kind: 'at', time, dayOffset };
      } else {
        throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].spec.kind must be 'after' or 'at'`);
      }
      const templateId = step.templateId == null ? undefined : String(step.templateId).trim();
      return { spec, at, ...(templateId ? { templateId } : {}) };
    });

    // The stored order IS the send order, so a caller cannot hand us a jumbled list and
    // rely on us to sort it — that would silently change which step is which.
    for (let i = 1; i < steps.length; i++) {
      if (new Date(steps[i].at) <= new Date(steps[i - 1].at)) {
        throw new WorkflowError('SCHEDULE_INVALID', 'sequence steps must be strictly increasing');
      }
    }

    const schedule: WorkflowSchedule = {
      frequency: 'sequence',
      startAt: parseIsoInstant(s.startAt, 'schedule.startAt'),
      steps,
    };
    validateSequencePolicy(schedule);
    return schedule;
  }

  const time = String(s.time ?? '');
  if (!HHMM.test(time)) throw new WorkflowError('SCHEDULE_INVALID', 'time must be HH:mm');

  const dayOfWeek = s.dayOfWeek == null ? undefined : Number(s.dayOfWeek);
  const dayOfMonth = s.dayOfMonth == null ? undefined : Number(s.dayOfMonth);
  if (frequency === 'weekly' && !(dayOfWeek && dayOfWeek >= 1 && dayOfWeek <= 7)) {
    throw new WorkflowError('SCHEDULE_INVALID', 'dayOfWeek required (ISO 1–7)');
  }
  if (frequency === 'monthly' && !(dayOfMonth && dayOfMonth >= 1 && dayOfMonth <= 31)) {
    throw new WorkflowError('SCHEDULE_INVALID', 'dayOfMonth required (1–31)');
  }
  const endDate = s.endDate == null ? undefined : String(s.endDate);
  if (endDate && !YMD.test(endDate)) {
    throw new WorkflowError('SCHEDULE_INVALID', 'endDate must be YYYY-MM-DD');
  }
  const maxRuns = s.maxRuns == null ? undefined : Number(s.maxRuns);
  if (maxRuns != null && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
    throw new WorkflowError('SCHEDULE_INVALID', 'maxRuns must be >= 1');
  }

  return {
    frequency: frequency as Frequency,
    time,
    ...(frequency === 'weekly' ? { dayOfWeek } : {}),
    ...(frequency === 'monthly' ? { dayOfMonth } : {}),
    ...(endDate ? { endDate } : {}),
    ...(maxRuns != null ? { maxRuns } : {}),
  };
}

/**
 * Older clients express a one-time send as `executionMode:'once' + oneTimeSendAt`.
 * Normalize that into the first-class `{frequency:'once', runAt}` shape so there is
 * exactly one representation downstream.
 */
function normalizeLegacyOnce(
  raw: Record<string, unknown>,
  schedule: WorkflowSchedule | undefined,
): WorkflowSchedule | undefined {
  const legacyMode = String(raw.executionMode ?? '').trim().toLowerCase();
  const legacyAt = raw.oneTimeSendAt == null ? '' : String(raw.oneTimeSendAt).trim();
  if (schedule?.frequency === 'once') return schedule;
  if (legacyMode !== 'once' && !legacyAt) return schedule;
  if (legacyMode && legacyMode !== 'once' && legacyMode !== 'recurring') {
    throw new WorkflowError('CONTRACT_INVALID', 'executionMode must be recurring or once');
  }
  if (legacyAt) {
    return { frequency: 'once', runAt: parseIsoInstant(legacyAt, 'oneTimeSendAt') };
  }
  // executionMode:'once' with no instant means "send now".
  return { frequency: 'once', runAt: new Date().toISOString() };
}

export function parseContract(input: unknown): WorkflowCommandContractV1 {
  if (!input || typeof input !== 'object') throw new WorkflowError('CONTRACT_INVALID', 'contract required');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 'v1') throw new WorkflowError('CONTRACT_INVALID', 'version must be v1');
  const action = String(raw.action ?? '');
  if (!ACTIONS.has(action)) throw new WorkflowError('CONTRACT_INVALID', 'invalid action');

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_MIN) {
    throw new WorkflowError('CONTRACT_INVALID', 'needs_clarification');
  }
  const requestId = String(raw.requestId ?? '').trim();
  if (!requestId) throw new WorkflowError('CONTRACT_INVALID', 'requestId required');

  const workflowId = raw.workflowId != null ? String(raw.workflowId).trim() : undefined;
  if (action !== 'create' && action !== 'list' && !workflowId) {
    throw new WorkflowError('CONTRACT_INVALID', 'workflowId required');
  }

  let schedule = raw.schedule != null ? parseSchedule(raw.schedule) : undefined;
  schedule = normalizeLegacyOnce(raw, schedule);

  if (action === 'create' && !schedule) {
    throw new WorkflowError('SCHEDULE_INVALID', 'schedule required');
  }

  const recipientIds = Array.isArray(raw.recipientIds)
    ? raw.recipientIds.map((id) => String(id).trim()).filter(Boolean)
    : undefined;
  if (recipientIds && recipientIds.length > MAX_RECIPIENTS) {
    throw new WorkflowError('CONTRACT_INVALID', `max ${MAX_RECIPIENTS} recipients`);
  }

  let variables: Record<string, string> | undefined;
  if (raw.variables != null && typeof raw.variables === 'object' && !Array.isArray(raw.variables)) {
    variables = {};
    for (const [k, v] of Object.entries(raw.variables as Record<string, unknown>)) {
      variables[k] = String(v ?? '');
    }
  }

  const executionMode = schedule ? executionModeOf(schedule) : undefined;

  return {
    version: 'v1',
    action: action as WorkflowAction,
    ...(executionMode ? { executionMode } : {}),
    ...(schedule?.runAt ? { oneTimeSendAt: schedule.runAt } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(raw.templateId != null ? { templateId: String(raw.templateId).trim() } : {}),
    ...(recipientIds ? { recipientIds } : {}),
    ...(schedule ? { schedule } : {}),
    ...(variables ? { variables } : {}),
    confidence,
    requestId,
  };
}

export function newRequestId(): string {
  return randomUUID();
}

import assert from 'node:assert/strict';

if (process.argv[1]?.endsWith('contract.ts')) {
  const base = {
    version: 'v1',
    action: 'create',
    templateId: 'follow-up-1',
    recipientIds: ['lead-1'],
    schedule: { frequency: 'weekly', time: '10:00', dayOfWeek: 1 },
    variables: { status: 'On track' },
    confidence: 0.9,
    requestId: 'req-1',
    unknownFuture: true,
  };
  const c = parseContract(base);
  assert.equal(c.version, 'v1');
  assert.equal(c.action, 'create');
  assert.equal(c.executionMode, 'recurring');
  assert.equal((c as { unknownFuture?: boolean }).unknownFuture, undefined);
  assert.throws(() => parseContract({ ...base, confidence: 0.69 }), /needs_clarification/);
  assert.throws(() => parseContract({ ...base, action: 'pause' }), /workflowId/);

  // once is first-class
  const once = parseContract({
    ...base,
    schedule: { frequency: 'once', runAt: '2026-12-31T10:00:00.000Z' },
  });
  assert.equal(once.schedule?.frequency, 'once');
  assert.equal(once.schedule?.runAt, '2026-12-31T10:00:00.000Z');
  assert.equal(once.executionMode, 'once');
  assert.equal(once.schedule?.maxRuns, undefined, 'no hidden maxRuns substitute');
  assert.throws(() => parseContract({ ...base, schedule: { frequency: 'once' } }), /runAt/);

  // legacy executionMode/oneTimeSendAt still accepted and normalized
  const legacy = parseContract({
    ...base,
    executionMode: 'once',
    oneTimeSendAt: '2026-12-31T10:00:00.000Z',
    schedule: undefined,
  });
  assert.equal(legacy.schedule?.frequency, 'once');
  assert.equal(legacy.schedule?.runAt, '2026-12-31T10:00:00.000Z');
  assert.equal(legacy.oneTimeSendAt, '2026-12-31T10:00:00.000Z');

  assert.throws(() => parseContract({ ...base, schedule: { frequency: 'weekly', time: '10:00' } }), /dayOfWeek/);
  assert.throws(() => parseContract({ ...base, schedule: { frequency: 'hourly', time: '10:00' } }));
  assert.throws(() => parseContract({ ...base, schedule: undefined }), /schedule required/);

  const seqStart = '2026-08-21T04:30:00.000Z';
  const seqSteps = [
    { spec: { kind: 'after', minutes: 60, from: 'previous' }, at: '2026-08-21T05:30:00.000Z' },
    { spec: { kind: 'at', time: '14:00', dayOffset: 0 }, at: '2026-08-21T08:30:00.000Z' },
    { spec: { kind: 'after', minutes: 120, from: 'previous' }, at: '2026-08-21T10:30:00.000Z' },
  ];
  const seqContract = parseContract({
    ...base,
    schedule: { frequency: 'sequence', startAt: seqStart, steps: seqSteps },
  });
  assert.equal(seqContract.schedule?.frequency, 'sequence');
  assert.equal(seqContract.schedule?.startAt, seqStart);
  assert.deepEqual(seqContract.schedule?.steps, seqSteps);
  assert.throws(
    () => parseContract({ ...base, schedule: { frequency: 'sequence', startAt: seqStart, steps: [] } }),
    /at least one step/,
  );
  assert.throws(
    () =>
      parseContract({
        ...base,
        schedule: {
          frequency: 'sequence',
          startAt: seqStart,
          steps: [
            { spec: { kind: 'after', minutes: 60, from: 'previous' }, at: '2026-08-21T10:30:00.000Z' },
            { spec: { kind: 'at', time: '14:00', dayOffset: 0 }, at: '2026-08-21T08:30:00.000Z' },
          ],
        },
      }),
    /strictly increasing/,
  );
  assert.throws(
    () =>
      parseContract({
        ...base,
        schedule: {
          frequency: 'sequence',
          startAt: seqStart,
          steps: [
            { spec: { kind: 'after', minutes: 60, from: 'bogus' }, at: '2026-08-21T05:30:00.000Z' },
            { spec: { kind: 'at', time: '14:00', dayOffset: 0 }, at: '2026-08-21T08:30:00.000Z' },
          ],
        },
      }),
    /from must be/,
  );
  assert.throws(
    () =>
      parseContract({
        ...base,
        schedule: {
          frequency: 'sequence',
          startAt: seqStart,
          steps: Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, (_, i) => ({
            spec: { kind: 'after', minutes: 60, from: 'previous' as const },
            at: new Date(new Date(seqStart).getTime() + (i + 1) * 3_600_000).toISOString(),
          })),
        },
      }),
    /at most 20/,
  );
  assert.throws(
    () =>
      parseContract({
        ...base,
        schedule: {
          frequency: 'sequence',
          startAt: seqStart,
          steps: [
            { spec: { kind: 'after', minutes: 0, from: 'start' }, at: '2026-08-21T05:30:00.000Z' },
            { spec: { kind: 'after', minutes: 1, from: 'previous' }, at: '2026-08-21T05:31:00.000Z' },
          ],
        },
      }),
    /5 minutes apart/,
  );
  assert.throws(
    () =>
      parseContract({
        ...base,
        schedule: {
          frequency: 'sequence',
          startAt: seqStart,
          steps: [
            { spec: { kind: 'after', minutes: 0, from: 'start' }, at: '2026-08-21T05:30:00.000Z' },
            { spec: { kind: 'at', time: '10:00', dayOffset: 366 }, at: '2027-08-22T04:30:00.000Z' },
          ],
        },
      }),
    /365 days/,
  );
  assert.throws(
    () =>
      validateSequencePolicy({
        frequency: 'sequence',
        startAt: seqStart,
        steps: [
          { spec: { kind: 'after', minutes: 60, from: 'nope' as 'start' }, at: '2026-08-21T05:30:00.000Z' },
          { spec: { kind: 'after', minutes: 60, from: 'previous' }, at: '2026-08-21T06:30:00.000Z' },
        ],
      }),
    /from must be/,
  );
  assert.equal(executionModeOf({ frequency: 'daily', time: '10:00' }), 'recurring');
  assert.equal(isOnceSchedule({ frequency: 'once', runAt: new Date().toISOString() }), true);
  console.log('contract self-check passed');
}
