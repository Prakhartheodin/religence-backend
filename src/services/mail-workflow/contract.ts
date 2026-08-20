export const CONTRACT_VERSION = 'v1' as const;
export const CONFIDENCE_MIN = 0.7;
export const MAX_RECIPIENTS = 50;
export const CRM_MERGE_KEYS = [
  'company_name', 'contact_name', 'salt_name', 'medicine_name', 'dosage_form', 'sender_name',
] as const;

export type WorkflowAction = 'create' | 'update' | 'pause' | 'resume' | 'cancel' | 'list';
export type WorkflowStatus =
  | 'draft_requires_auth' | 'pending_confirm' | 'active' | 'paused' | 'completed' | 'cancelled';
export type RunStatus = 'running' | 'success' | 'failed' | 'skipped';
export type Frequency = 'daily' | 'weekly' | 'monthly';

export type WorkflowSchedule = {
  frequency: Frequency;
  time: string; // HH:mm
  dayOfWeek?: number; // weekly ISO 1–7
  dayOfMonth?: number; // monthly 1–31
  endDate?: string; // YYYY-MM-DD
  maxRuns?: number;
};

export type WorkflowCommandContractV1 = {
  version: 'v1';
  action: WorkflowAction;
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
const FREQ = new Set(['daily', 'weekly', 'monthly']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

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

  let schedule: WorkflowSchedule | undefined;
  if (raw.schedule != null) {
    if (typeof raw.schedule !== 'object') throw new WorkflowError('SCHEDULE_INVALID', 'schedule must be object');
    const s = raw.schedule as Record<string, unknown>;
    const frequency = String(s.frequency ?? '');
    const time = String(s.time ?? '');
    if (!FREQ.has(frequency)) throw new WorkflowError('SCHEDULE_INVALID', 'invalid frequency');
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
    if (endDate && !YMD.test(endDate)) throw new WorkflowError('SCHEDULE_INVALID', 'endDate must be YYYY-MM-DD');
    const maxRuns = s.maxRuns == null ? undefined : Number(s.maxRuns);
    if (maxRuns != null && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
      throw new WorkflowError('SCHEDULE_INVALID', 'maxRuns must be >= 1');
    }
    schedule = {
      frequency: frequency as Frequency,
      time,
      ...(frequency === 'weekly' ? { dayOfWeek } : {}),
      ...(frequency === 'monthly' ? { dayOfMonth } : {}),
      ...(endDate ? { endDate } : {}),
      ...(maxRuns != null ? { maxRuns } : {}),
    };
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

  return {
    version: 'v1',
    action: action as WorkflowAction,
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
  assert.equal((c as { unknownFuture?: boolean }).unknownFuture, undefined);
  assert.throws(() => parseContract({ ...base, confidence: 0.69 }), /needs_clarification/);
  assert.throws(() => parseContract({ ...base, action: 'pause' }), /workflowId/);
  assert.throws(() => parseContract({ ...base, schedule: { frequency: 'weekly', time: '10:00' } }), /dayOfWeek/);
  assert.throws(() => parseContract({ ...base, schedule: { frequency: 'hourly', time: '10:00' } }));
  console.log('contract self-check passed');
}
