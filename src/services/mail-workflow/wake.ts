/**
 * Lets the create path nudge the scheduler for "send now" without importing it
 * (workflow.service <- scheduler, so the reverse edge would be circular).
 */
let waker: (() => void) | null = null;

export function setImmediateWaker(fn: () => void): void {
  waker = fn;
}

export function scheduleImmediateWake(): void {
  if (!waker) return;
  const fn = waker;
  setTimeout(() => {
    try {
      fn();
    } catch {
      /* the periodic tick will pick the work up anyway */
    }
  }, 50).unref?.();
}
