import assert from 'node:assert/strict';
import type { WorkflowSchedule } from './contract.js';

function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

export function utcFromZoned(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  // ponytail: binary search UTC millis whose zoned parts match (handles DST)
  let lo = Date.UTC(y, mo - 1, d, h, mi) - 36e5 * 36;
  let hi = lo + 36e5 * 72;
  let result: Date | null = null;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const p = zonedParts(new Date(mid), timeZone);
    const cmp =
      p.year !== y ? p.year - y :
      p.month !== mo ? p.month - mo :
      p.day !== d ? p.day - d :
      p.hour !== h ? p.hour - h :
      p.minute - mi;
    if (cmp === 0) {
      result = new Date(mid);
      hi = mid - 1;
    } else if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  if (result) return result;
  // Spring-forward gap: this wall-clock time does not exist. The search converged with
  // `lo` at the first instant whose local time is PAST the requested one — exactly where
  // the clocks land after the jump.
  //
  // The old fallback returned Date.UTC(y, mo-1, d, h, mi), which is the requested civil
  // time read as UTC, not as local. For New York that put a nonexistent 02:30 at
  // 21:30 the PREVIOUS evening. Invisible while every schedule ran in a zone without DST.
  return new Date(lo);
}

function lastDayOfMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function isoDowFromYmd(y: number, mo: number, d: number): number {
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

export function addCivilDays(y: number, mo: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function civilDateInZone(utc: Date, timezone: string): string {
  const p = zonedParts(utc, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function endDateReached(schedule: WorkflowSchedule, timezone: string, occurrenceUtc: Date): boolean {
  if (!schedule.endDate) return false;
  return civilDateInZone(occurrenceUtc, timezone) > schedule.endDate;
}

function dayMatchesSchedule(schedule: WorkflowSchedule, y: number, mo: number, d: number): boolean {
  if (schedule.frequency === 'daily') return true;
  if (schedule.frequency === 'weekly') return isoDowFromYmd(y, mo, d) === schedule.dayOfWeek;
  const dom = schedule.dayOfMonth!;
  return d === Math.min(dom, lastDayOfMonth(y, mo));
}

export function scheduleRunAt(schedule: WorkflowSchedule): Date | null {
  if (schedule.frequency !== 'once' || !schedule.runAt) return null;
  const dt = new Date(schedule.runAt);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Next occurrence strictly after `afterOccurrence ?? fromUtc`.
 * Returns null when the schedule has no further occurrence (a `once` schedule that has
 * already fired, or a bounded schedule past its end).
 */
export function computeNextRunAt(
  schedule: WorkflowSchedule,
  timezone: string,
  fromUtc: Date,
  opts?: { afterOccurrence?: Date }
): Date | null {
  const after = opts?.afterOccurrence ?? fromUtc;

  if (schedule.frequency === 'once') {
    const at = scheduleRunAt(schedule);
    if (!at) return null;
    return at > after ? at : null;
  }

  const [hStr, mStr] = String(schedule.time ?? '').split(':');
  const h = Number(hStr);
  const mi = Number(mStr);
  if (!Number.isInteger(h) || !Number.isInteger(mi)) {
    throw new Error(`invalid schedule time: ${String(schedule.time)}`);
  }

  const start = civilDateInZone(after, timezone);
  let { year: y, month: mo, day: d } = {
    year: Number(start.slice(0, 4)),
    month: Number(start.slice(5, 7)),
    day: Number(start.slice(8, 10)),
  };

  for (let i = 0; i < 400; i++) {
    if (dayMatchesSchedule(schedule, y, mo, d)) {
      const candidate = utcFromZoned(timezone, y, mo, d, h, mi);
      if (candidate > after) {
        return endDateReached(schedule, timezone, candidate) ? null : candidate;
      }
    }
    ({ year: y, month: mo, day: d } = addCivilDays(y, mo, d, 1));
  }
  return null;
}

/** Default: an occurrence more than this far in the past is stale and will not be sent. */
export const DEFAULT_MAX_MISSED_RUN_AGE_MS = 2 * 60 * 60 * 1000;

export function maxMissedRunAgeMs(): number {
  const raw = Number(process.env.MAX_MISSED_RUN_AGE_MINUTES);
  if (Number.isFinite(raw) && raw > 0) return raw * 60 * 1000;
  return DEFAULT_MAX_MISSED_RUN_AGE_MS;
}

export type CatchUpPlan =
  /** Not due yet — leave it alone. */
  | { action: 'wait' }
  /** Due and fresh enough to send. */
  | { action: 'run'; occurrence: Date }
  /**
   * One or more occurrences were missed and are too old to send. Skip them and jump to
   * `nextRunAt`; if `nextRunAt` is null the workflow is finished.
   */
  | { action: 'skip'; skipped: number; lastSkipped: Date; nextRunAt: Date | null; runNow: Date | null }
  /** No further occurrences. */
  | { action: 'complete' };

/**
 * Decide what to do with a due occurrence without ever producing a burst of historical
 * sends. Policy: skip every occurrence older than `maxAgeMs`, then run at most the single
 * most recent due occurrence.
 */
export function planCatchUp(
  schedule: WorkflowSchedule,
  timezone: string,
  nextRunAt: Date | null,
  now: Date,
  maxAgeMs = maxMissedRunAgeMs(),
): CatchUpPlan {
  if (!nextRunAt) return { action: 'complete' };
  if (nextRunAt > now) return { action: 'wait' };

  // Walk to the LAST occurrence that is already due, never stopping at the first one.
  //
  // Stopping early leaves a second due occurrence behind, and the scheduler points
  // nextRunAt straight at it — so the tick 30s later sends that one too, and the one
  // after that, until the backlog drains. That is the burst this function's contract
  // exists to prevent.
  //
  // It never showed up because daily/weekly/monthly occurrences are >=24h apart and the
  // freshness window is 2h, so only one of them can ever be due-and-fresh. The policy held
  // by accident of gap size. Any schedule whose occurrences sit closer together than
  // maxAgeMs breaks that accident.
  //
  // Bounded so a years-old workflow cannot spin.
  let dueCount = 1;
  let due = nextRunAt;
  let previousDue = nextRunAt;

  for (let i = 0; i < 5000; i++) {
    const next = computeNextRunAt(schedule, timezone, now, { afterOccurrence: due });
    if (!next || next > now) break;
    previousDue = due;
    due = next;
    dueCount++;
  }

  const isFresh = now.getTime() - due.getTime() <= maxAgeMs;

  // `due` is the newest occurrence that is due, so if it is too old every earlier one is
  // older still — the whole backlog is dropped and the workflow jumps past it.
  if (!isFresh) {
    return {
      action: 'skip',
      skipped: dueCount,
      lastSkipped: due,
      nextRunAt: computeNextRunAt(schedule, timezone, now, { afterOccurrence: due }),
      runNow: null,
    };
  }

  if (dueCount === 1) return { action: 'run', occurrence: due };

  // Run exactly the newest one; everything before it is dropped, however fresh it looks.
  return { action: 'skip', skipped: dueCount - 1, lastSkipped: previousDue, nextRunAt: due, runNow: due };
}

if (process.argv[1]?.endsWith('recurrence.ts')) {
  const weekly: WorkflowSchedule = { frequency: 'weekly', time: '10:00', dayOfWeek: 1 };
  const next = computeNextRunAt(weekly, 'Asia/Kolkata', new Date('2026-08-21T12:00:00Z'));
  assert.equal(next!.toISOString(), '2026-08-24T04:30:00.000Z');

  const monthly: WorkflowSchedule = { frequency: 'monthly', time: '10:00', dayOfMonth: 31 };
  const feb = computeNextRunAt(monthly, 'Asia/Kolkata', new Date('2026-01-31T04:30:00Z'));
  assert.equal(civilDateInZone(feb!, 'Asia/Kolkata'), '2026-02-28');

  const daily: WorkflowSchedule = { frequency: 'daily', time: '10:00', endDate: '2026-08-24' };
  assert.equal(endDateReached(daily, 'Asia/Kolkata', new Date('2026-08-24T04:30:00Z')), false);
  assert.equal(endDateReached(daily, 'Asia/Kolkata', new Date('2026-08-25T04:30:00Z')), true);
  // past endDate the schedule is finished, not "400 days away"
  assert.equal(computeNextRunAt(daily, 'Asia/Kolkata', new Date('2026-08-24T05:00:00Z')), null);

  const ny = computeNextRunAt(
    { frequency: 'daily', time: '02:30' },
    'America/New_York',
    new Date('2026-03-07T10:00:00Z')
  );
  assert.ok(ny! > new Date('2026-03-07T10:00:00Z'));

  // DST spring-forward: 02:30 does not exist on 2026-03-08 in New York — the clocks jump
  // 02:00 EST straight to 03:00 EDT. It must resolve to 03:00 EDT, the first instant after
  // the gap. The old fallback read the civil time as UTC and landed on 21:30 on March 7.
  assert.equal(
    utcFromZoned('America/New_York', 2026, 3, 8, 2, 30).toISOString(),
    '2026-03-08T07:00:00.000Z',
    'a nonexistent wall clock resolves to the instant the clocks land on',
  );

  const gap = computeNextRunAt(
    { frequency: 'daily', time: '02:30' },
    'America/New_York',
    new Date('2026-03-08T06:00:00Z')
  );
  assert.ok(gap! > new Date('2026-03-08T06:00:00Z'), 'DST gap still yields an occurrence');
  assert.equal(
    civilDateInZone(gap!, 'America/New_York'),
    '2026-03-08',
    'the gap day gets an occurrence rather than being skipped entirely',
  );

  // DST fall-back: 01:30 happens twice on 2026-11-01; we must pick one and move on.
  const ambiguous = computeNextRunAt(
    { frequency: 'daily', time: '01:30' },
    'America/New_York',
    new Date('2026-10-31T12:00:00Z')
  );
  assert.equal(civilDateInZone(ambiguous!, 'America/New_York'), '2026-11-01');

  // once
  const onceAt = '2026-12-31T10:00:00.000Z';
  const once: WorkflowSchedule = { frequency: 'once', runAt: onceAt };
  assert.equal(computeNextRunAt(once, 'Asia/Kolkata', new Date('2026-01-01T00:00:00Z'))!.toISOString(), onceAt);
  assert.equal(
    computeNextRunAt(once, 'Asia/Kolkata', new Date('2027-01-01T00:00:00Z')),
    null,
    'a once schedule does not repeat',
  );

  // catch-up policy
  const dailyTen: WorkflowSchedule = { frequency: 'daily', time: '10:00' };
  const tz = 'Asia/Kolkata';
  const nowT = new Date('2026-08-25T05:00:00Z'); // 10:30 IST

  assert.equal(planCatchUp(dailyTen, tz, new Date('2026-08-25T06:00:00Z'), nowT).action, 'wait');
  const fresh = planCatchUp(dailyTen, tz, new Date('2026-08-25T04:30:00Z'), nowT);
  assert.equal(fresh.action, 'run');

  // scheduler down 3 days: must NOT run three historical sends
  const stale = planCatchUp(dailyTen, tz, new Date('2026-08-22T04:30:00Z'), nowT);
  assert.equal(stale.action, 'skip');
  if (stale.action === 'skip') {
    assert.equal(stale.skipped, 3, 'three stale occurrences skipped');
    assert.equal(
      stale.runNow!.toISOString(),
      '2026-08-25T04:30:00.000Z',
      'only the latest still-fresh occurrence runs',
    );
  }

  // Regression: a burst stays impossible even when SEVERAL occurrences are due and fresh
  // at the same time. Freshness is widened to 3 days so three daily occurrences qualify —
  // the shape any schedule takes once its gap is shorter than maxAgeMs. Driven through
  // consecutive ticks exactly as scheduler.ts does, because the burst only appears across
  // ticks: each one looks perfectly reasonable on its own.
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  let backlog: Date | null = new Date('2026-08-22T04:30:00Z');
  let sends = 0;
  for (let tick = 0; tick < 6 && backlog; tick++) {
    const plan = planCatchUp(dailyTen, tz, backlog, nowT, THREE_DAYS_MS);
    if (plan.action === 'wait' || plan.action === 'complete') break;
    const occurrence = plan.action === 'run' ? plan.occurrence : plan.runNow;
    if (!occurrence) {
      backlog = plan.action === 'skip' ? plan.nextRunAt : null;
      continue;
    }
    sends++;
    backlog = computeNextRunAt(dailyTen, tz, nowT, { afterOccurrence: occurrence });
  }
  assert.equal(sends, 1, 'a backlog of fresh occurrences must still produce exactly ONE send');

  // stale one-time send is dropped, never delivered days late
  const staleOnce = planCatchUp(
    { frequency: 'once', runAt: '2026-08-20T04:30:00.000Z' },
    tz,
    new Date('2026-08-20T04:30:00.000Z'),
    nowT,
  );
  assert.equal(staleOnce.action, 'skip');
  if (staleOnce.action === 'skip') {
    assert.equal(staleOnce.nextRunAt, null);
    assert.equal(staleOnce.runNow, null);
  }

  assert.equal(planCatchUp(dailyTen, tz, null, nowT).action, 'complete');
  console.log('recurrence self-check passed');
}
