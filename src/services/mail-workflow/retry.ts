import assert from 'node:assert/strict';

export function providerIdempotencyKey(userId: string, workflowId: string, scheduledAt: Date): string {
  return `${userId}:${workflowId}:${scheduledAt.toISOString()}`;
}

export function backoffMs(attemptIndex0: number): number {
  return [10_000, 30_000, 90_000][attemptIndex0] ?? 90_000;
}

export function classifySendError(err: unknown): { retriable: boolean; code: string; message: string } {
  const status = (err as { status?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { httpStatus?: number }).httpStatus;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 429 || (status != null && status >= 500) || /timeout|ECONNRESET|ENOTFOUND|network/i.test(message)) {
    return { retriable: true, code: String(status ?? 'NETWORK'), message };
  }
  if (status === 401 || status === 403) return { retriable: false, code: 'AUTH_REQUIRED', message };
  return { retriable: false, code: String(status ?? 'SEND_FAILED'), message };
}

if (process.argv[1]?.endsWith('retry.ts')) {
  assert.equal(providerIdempotencyKey('u', 'w', new Date('2026-08-24T04:30:00.000Z')), 'u:w:2026-08-24T04:30:00.000Z');
  assert.equal(backoffMs(0), 10_000);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 90_000);
  assert.equal(classifySendError({ status: 429, message: 'throttle' }).retriable, true);
  assert.equal(classifySendError({ status: 403, message: 'forbidden' }).retriable, false);
  assert.equal(classifySendError({ status: 401, message: 'expired' }).code, 'AUTH_REQUIRED');
  console.log('retry self-check passed');
}
