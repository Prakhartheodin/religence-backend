/**
 * Structured logging for the mail workflow pipeline.
 * Every line carries the correlation ids needed to reconstruct an incident.
 * Secrets (tokens, refresh tokens, message bodies) must never be passed in.
 */

export type MailLogContext = {
  workspaceId?: string;
  userId?: string;
  workflowId?: string;
  runId?: string;
  requestId?: string;
  recipientId?: string;
  [key: string]: unknown;
};

const REDACTED_KEYS = /token|secret|password|authorization|refresh|accessToken|body|html/i;

function scrub(ctx: MailLogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (REDACTED_KEYS.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (v === undefined) continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

function emit(level: 'info' | 'warn' | 'error', event: string, ctx: MailLogContext): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: 'mail-workflow',
    event,
    ...scrub(ctx),
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const mailLog = {
  info: (event: string, ctx: MailLogContext = {}) => emit('info', event, ctx),
  warn: (event: string, ctx: MailLogContext = {}) => emit('warn', event, ctx),
  error: (event: string, ctx: MailLogContext = {}) => emit('error', event, ctx),
};
