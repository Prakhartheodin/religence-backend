import assert from 'node:assert/strict';

export function providerIdempotencyKey(userId: string, workflowId: string, scheduledAt: Date): string {
  return `${userId}:${workflowId}:${scheduledAt.toISOString()}`;
}

export function backoffMs(attemptIndex0: number): number {
  return [10_000, 30_000, 90_000][attemptIndex0] ?? 90_000;
}

export function classifySendError(err: unknown): {
  retriable: boolean;
  code: string;
  message: string;
  retryAfterMs?: number;
} {
  const status = (err as { status?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { httpStatus?: number }).httpStatus;
  const message = err instanceof Error ? err.message : String(err);
  const retryAfterMs = parseRetryAfterMs(err);
  if (status === 429 || status === 503 || status === 504) {
    return { retriable: true, code: String(status), message, retryAfterMs };
  }
  if (status === 401 || status === 403) return { retriable: false, code: 'AUTH_REQUIRED', message };
  return { retriable: false, code: String(status ?? 'SEND_FAILED'), message };
}

/** Honor Graph Retry-After when present; otherwise exponential backoff for throttle errors. */
export function sendRetryDelayMs(err: unknown, attemptIndex0: number): number {
  const classified = classifySendError(err);
  if (!classified.retriable) return 0;
  if (classified.retryAfterMs != null) return classified.retryAfterMs;
  return backoffMs(attemptIndex0);
}

function parseRetryAfterMs(err: unknown): number | undefined {
  const raw = err as {
    headers?: Record<string, string | number | undefined>;
    response?: { headers?: Record<string, string | number | undefined> };
  };
  const headers = raw.headers ?? raw.response?.headers;
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (value == null) return undefined;
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.ceil(asNum * 1000);
  const asDate = Date.parse(String(value));
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

if (process.argv[1]?.endsWith('retry.ts')) {
  assert.equal(providerIdempotencyKey('u', 'w', new Date('2026-08-24T04:30:00.000Z')), 'u:w:2026-08-24T04:30:00.000Z');
  assert.equal(backoffMs(0), 10_000);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 90_000);
  assert.equal(classifySendError({ status: 429, message: 'throttle' }).retriable, true);
  assert.equal(classifySendError({ status: 503, message: 'unavailable' }).retriable, true);
  assert.equal(classifySendError({ status: 504, message: 'timeout' }).retriable, true);
  assert.equal(classifySendError({ status: 500, message: 'err' }).retriable, false);
  assert.equal(classifySendError({ status: 403, message: 'forbidden' }).retriable, false);
  assert.equal(classifySendError({ status: 401, message: 'expired' }).code, 'AUTH_REQUIRED');
  assert.equal(
    classifySendError({ status: 429, message: 'throttle', headers: { 'retry-after': '45' } }).retryAfterMs,
    45_000,
  );
  assert.equal(sendRetryDelayMs({ status: 429, headers: { 'retry-after': '12' } }, 0), 12_000);
  assert.equal(sendRetryDelayMs({ status: 429, message: 'throttle' }, 1), 30_000);
  console.log('retry self-check passed');
}
