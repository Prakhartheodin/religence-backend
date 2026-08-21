import assert from 'node:assert/strict';
import { MailWorkflowRunModel } from '../../models/mail-workflow-run.model.js';
import config from '../../config.js';

/** Per-mailbox send pace — structure/UX guardrail; Graph may throttle lower. */
export const MAILBOX_SEND_PACE_PER_MIN = 20;
export const MAILBOX_MAX_IN_FLIGHT = 2;
export const MAILBOX_RECIPIENTS_PER_DAY_SOFT = 8000;
export const TENANT_TERRL_FRACTION = 0.8;
/** ponytail: M365 default TERRL is often 10k; when unknown we apply 80% of this (8000). */
export const FALLBACK_TERRL_EXTERNAL_PER_DAY = 10000;

export type SendGuardLimits = {
  pacePerMin: number;
  maxInFlight: number;
  mailboxRecipientsPerDay: number;
  tenantExternalPerDay: number;
};

export type SendGuardSnapshot = {
  sentLastMinute: number;
  inFlight: number;
  recipientsToday: number;
  tenantExternalToday: number;
};

export type SendGuardDecision =
  | { allow: true }
  | { allow: false; reason: string; retryAfterMs: number };

export function tenantExternalDailyCap(terrl?: number | null): number {
  const base = terrl ?? FALLBACK_TERRL_EXTERNAL_PER_DAY;
  return Math.floor(base * TENANT_TERRL_FRACTION);
}

export function defaultSendGuardLimits(): SendGuardLimits {
  const terrl = config.mail?.tenantExternalRecipientLimit ?? null;
  return {
    pacePerMin: MAILBOX_SEND_PACE_PER_MIN,
    maxInFlight: MAILBOX_MAX_IN_FLIGHT,
    mailboxRecipientsPerDay: MAILBOX_RECIPIENTS_PER_DAY_SOFT,
    tenantExternalPerDay: tenantExternalDailyCap(terrl),
  };
}

export function evaluateSendGuard(
  snap: SendGuardSnapshot,
  limits: SendGuardLimits,
): SendGuardDecision {
  if (snap.inFlight >= limits.maxInFlight) {
    return { allow: false, reason: 'MAILBOX_CONCURRENCY', retryAfterMs: 30_000 };
  }
  if (snap.sentLastMinute >= limits.pacePerMin) {
    return { allow: false, reason: 'MAILBOX_PACE', retryAfterMs: 60_000 };
  }
  if (snap.recipientsToday >= limits.mailboxRecipientsPerDay) {
    return { allow: false, reason: 'MAILBOX_DAILY_SOFT_CAP', retryAfterMs: 3_600_000 };
  }
  if (snap.tenantExternalToday >= limits.tenantExternalPerDay) {
    return { allow: false, reason: 'TENANT_EXTERNAL_DAILY_CAP', retryAfterMs: 3_600_000 };
  }
  return { allow: true };
}

async function countRecipients(
  userId: string,
  match: Record<string, unknown>,
): Promise<number> {
  const rows = await MailWorkflowRunModel.aggregate([
    { $match: { userId } },
    { $unwind: '$recipients' },
    { $match: match },
    { $count: 'n' },
  ]);
  return rows[0]?.n ?? 0;
}

/** v1 tenant key is userId — tenant and mailbox daily counts coincide until org tenancy exists. */
export async function loadSendGuardSnapshot(userId: string, now = new Date()): Promise<SendGuardSnapshot> {
  const minuteAgo = new Date(now.getTime() - 60_000);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  const [sentLastMinute, inFlight, recipientsToday] = await Promise.all([
    countRecipients(userId, { 'recipients.acceptedAt': { $gte: minuteAgo } }),
    countRecipients(userId, { 'recipients.status': 'sending' }),
    countRecipients(userId, {
      'recipients.status': 'sent',
      'recipients.acceptedAt': { $gte: dayStart },
    }),
  ]);

  return {
    sentLastMinute,
    inFlight,
    recipientsToday,
    tenantExternalToday: recipientsToday,
  };
}

if (process.argv[1]?.endsWith('send-guard.ts')) {
  assert.equal(tenantExternalDailyCap(null), 8000);
  assert.equal(tenantExternalDailyCap(12000), 9600);

  const limits = defaultSendGuardLimits();
  assert.equal(
    evaluateSendGuard({ sentLastMinute: 0, inFlight: 0, recipientsToday: 0, tenantExternalToday: 0 }, limits).allow,
    true,
  );
  const blocked = evaluateSendGuard(
    { sentLastMinute: 20, inFlight: 0, recipientsToday: 0, tenantExternalToday: 0 },
    limits,
  );
  assert.equal(blocked.allow, false);
  if (!blocked.allow) assert.equal(blocked.reason, 'MAILBOX_PACE');

  const inflight = evaluateSendGuard(
    { sentLastMinute: 0, inFlight: 2, recipientsToday: 0, tenantExternalToday: 0 },
    limits,
  );
  assert.equal(inflight.allow, false);
  if (!inflight.allow) assert.equal(inflight.reason, 'MAILBOX_CONCURRENCY');

  const dailySoft = evaluateSendGuard(
    {
      sentLastMinute: 0,
      inFlight: 0,
      recipientsToday: limits.mailboxRecipientsPerDay,
      tenantExternalToday: 0,
    },
    limits,
  );
  assert.equal(dailySoft.allow, false);
  if (!dailySoft.allow) assert.equal(dailySoft.reason, 'MAILBOX_DAILY_SOFT_CAP');

  const tenantDaily = evaluateSendGuard(
    {
      sentLastMinute: 0,
      inFlight: 0,
      recipientsToday: 0,
      tenantExternalToday: limits.tenantExternalPerDay,
    },
    limits,
  );
  assert.equal(tenantDaily.allow, false);
  if (!tenantDaily.allow) assert.equal(tenantDaily.reason, 'TENANT_EXTERNAL_DAILY_CAP');

  console.log('send-guard self-check passed');
}
