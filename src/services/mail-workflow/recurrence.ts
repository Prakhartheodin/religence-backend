import assert from 'node:assert/strict';
import type { StepSpec, WorkflowSchedule } from './contract.js';

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

  if (schedule.frequency === 'sequence') {
    const steps = schedule.steps ?? [];
    // A sequence with no steps is a corrupt row. Returning null here would set
    // status:'completed' and report success for a workflow that sent nothing.
    if (!steps.length) throw new Error('sequence schedule has no steps');

    // Scan for the EARLIEST instant after the cursor rather than the first one in array
    // order. Same cost, and it cannot pick the wrong step if a stored list is ever out of
    // order — which would also mis-map per-step templates.
    let best: Date | null = null;
    for (const step of steps) {
      const at = new Date(step.at);
      if (Number.isNaN(at.getTime())) {
        throw new Error(`invalid sequence step instant: ${String(step.at)}`);
      }
      if (at > after && (best === null || at < best)) best = at;
    }
    return best;
  }

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

/** A roll should need one day; only a DST shift can need two. Beyond that is a bug. */
const MAX_ROLL_DAYS = 3;

/**
 * Turn relative/absolute step specs into absolute instants, once, at preview time.
 *
 * Frozen on purpose: the card the user approves lists real dates, and confirming must not
 * move them. It also keeps the scheduler trivial — at runtime it reads a list and never
 * re-derives an offset.
 */
export function materializeSequence(
  startAt: Date,
  timezone: string,
  specs: StepSpec[],
): Date[] {
  if (Number.isNaN(startAt.getTime())) throw new Error('materializeSequence: invalid startAt');
  if (!specs.length) throw new Error('materializeSequence: no steps');

  const pad = (n: number) => String(n).padStart(2, '0');
  const out: Date[] = [];
  let prev = startAt;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    let t: Date;

    if (spec.kind === 'after') {
      if (!Number.isInteger(spec.minutes) || spec.minutes < 0) {
        throw new Error(`step ${i + 1}: minutes must be an integer >= 0`);
      }
      // Only the first step may be zero-delay ("send now, then ..."). A later zero would
      // collide with its predecessor.
      if (spec.minutes === 0 && i > 0) throw new Error(`step ${i + 1}: minutes must be >= 1`);
      const base = spec.from === 'start' ? startAt : prev;
      t = new Date(base.getTime() + spec.minutes * 60_000);
    } else {
      const hour = Number(spec.time.slice(0, 2));
      const minute = Number(spec.time.slice(3, 5));
      if (!/^\d{2}:\d{2}$/.test(spec.time) || hour > 23 || minute > 59) {
        throw new Error(`step ${i + 1}: invalid clock ${spec.time}`);
      }
      if (!Number.isInteger(spec.dayOffset) || spec.dayOffset < 0) {
        throw new Error(`step ${i + 1}: dayOffset must be >= 0`);
      }

      // Begin at the LATER of (startAt + dayOffset) and the previous step's own civil day.
      // Rolling one day at a time from dayOffset would cost up to 365 utcFromZoned calls,
      // and each of those is a binary search over ~40 Intl.formatToParts — a visible stall
      // inside a preview request.
      const startCivil = civilDateInZone(startAt, timezone);
      const shifted = addCivilDays(
        Number(startCivil.slice(0, 4)),
        Number(startCivil.slice(5, 7)),
        Number(startCivil.slice(8, 10)),
        spec.dayOffset,
      );
      const shiftedIso = `${shifted.year}-${pad(shifted.month)}-${pad(shifted.day)}`;
      const prevCivil = civilDateInZone(prev, timezone);
      let cur =
        shiftedIso >= prevCivil
          ? shifted
          : {
              year: Number(prevCivil.slice(0, 4)),
              month: Number(prevCivil.slice(5, 7)),
              day: Number(prevCivil.slice(8, 10)),
            };

      t = utcFromZoned(timezone, cur.year, cur.month, cur.day, hour, minute);
      // "2pm" said after a 3pm send obviously means tomorrow. Recomputing from civil parts
      // on each roll is what keeps this DST-correct.
      let rolls = 0;
      while (t <= prev) {
        if (++rolls > MAX_ROLL_DAYS) {
          throw new Error(`step ${i + 1}: ${spec.time} cannot be placed after the previous send`);
        }
        cur = addCivilDays(cur.year, cur.month, cur.day, 1);
        t = utcFromZoned(timezone, cur.year, cur.month, cur.day, hour, minute);
      }
    }

    // Step 1 may land exactly on startAt (zero-delay); later steps must be strictly after.
    if (i === 0 ? t < startAt : t <= prev) {
      throw new Error(`step ${i + 1}: resolves before the step it follows`);
    }
    out.push(t);
    prev = t;
  }

  return out;
}

/**
 * Which template a given occurrence belongs to, derived from its instant.
 *
 * Deliberately NOT derived from a counter. `recordSkippedOccurrence` writes a run row
 * without incrementing `runCount` — that happens only on execution — and N consecutive
 * missed occurrences produce a single row. After any outage both undercount, so a counter
 * would quietly hand step 3 the template that belongs to step 2.
 */
export function stepTemplateId(
  schedule: WorkflowSchedule,
  scheduledAt: Date,
): string | undefined {
  if (schedule.frequency !== 'sequence') return undefined;
  const iso = scheduledAt.toISOString();
  return schedule.steps?.find((s) => s.at === iso)?.templateId;
}

/** Default: an occurrence more than this far in the past is stale and will not be sent. */
export const DEFAULT_MAX_MISSED_RUN_AGE_MS = 2 * 60 * 60 * 1000;

const SKIP_DETAIL_LIMIT = 20;

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
  | {
      action: 'skip';
      skipped: number;
      lastSkipped: Date;
      /**
       * The skipped instants, newest last, capped at SKIP_DETAIL_LIMIT. `skipped` remains
       * the true count. A sequence never exceeds the cap, so its history is complete; a
       * years-old recurring backlog truncates, which is what the single summary row always
       * meant anyway.
       */
      skippedOccurrences: Date[];
      nextRunAt: Date | null;
      runNow: Date | null;
    }
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
  const allDue: Date[] = [nextRunAt];

  for (let i = 0; i < 5000; i++) {
    const next = computeNextRunAt(schedule, timezone, now, { afterOccurrence: due });
    if (!next || next > now) break;
    previousDue = due;
    due = next;
    dueCount++;
    allDue.push(due);
  }

  const isFresh = now.getTime() - due.getTime() <= maxAgeMs;

  // `due` is the newest occurrence that is due, so if it is too old every earlier one is
  // older still — the whole backlog is dropped and the workflow jumps past it.
  if (!isFresh) {
    const skippedOccurrences = allDue.slice(-SKIP_DETAIL_LIMIT);
    return {
      action: 'skip',
      skipped: dueCount,
      lastSkipped: due,
      skippedOccurrences,
      nextRunAt: computeNextRunAt(schedule, timezone, now, { afterOccurrence: due }),
      runNow: null,
    };
  }

  if (dueCount === 1) return { action: 'run', occurrence: due };

  // Run exactly the newest one; everything before it is dropped, however fresh it looks.
  const skippedOccurrences = allDue.slice(0, -1).slice(-SKIP_DETAIL_LIMIT);
  return {
    action: 'skip',
    skipped: dueCount - 1,
    lastSkipped: previousDue,
    skippedOccurrences,
    nextRunAt: due,
    runNow: due,
  };
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

  const seqFrom = (startIso: string, tzName: string, specs: StepSpec[]): WorkflowSchedule => {
    const at = materializeSequence(new Date(startIso), tzName, specs);
    return {
      frequency: 'sequence',
      startAt: startIso,
      steps: at.map((d, i) => ({ spec: specs[i], at: d.toISOString() })),
    };
  };

  // 1. §2 example
  const exStart = '2026-08-21T04:30:00.000Z';
  const exSpecs: StepSpec[] = [
    { kind: 'after', minutes: 60, from: 'previous' },
    { kind: 'at', time: '14:00', dayOffset: 0 },
    { kind: 'after', minutes: 120, from: 'previous' },
  ];
  const ex = seqFrom(exStart, 'Asia/Kolkata', exSpecs);
  assert.equal(ex.steps![0].at, '2026-08-21T05:30:00.000Z', '11:00 IST');
  assert.equal(ex.steps![1].at, '2026-08-21T08:30:00.000Z', '14:00 IST');
  assert.equal(ex.steps![2].at, '2026-08-21T10:30:00.000Z', '16:00 IST');

  // 2. Roll-forward
  const rollStart = '2026-08-21T03:00:00.000Z';
  const rollSpecs: StepSpec[] = [
    { kind: 'at', time: '10:00', dayOffset: 0 },
    { kind: 'at', time: '09:00', dayOffset: 0 },
  ];
  const roll = seqFrom(rollStart, 'Asia/Kolkata', rollSpecs);
  assert.equal(civilDateInZone(new Date(roll.steps![0].at), 'Asia/Kolkata'), '2026-08-21');
  assert.equal(civilDateInZone(new Date(roll.steps![1].at), 'Asia/Kolkata'), '2026-08-22');

  // 3. Same day, several steps
  const sameDaySpecs: StepSpec[] = [
    { kind: 'at', time: '14:00', dayOffset: 0 },
    { kind: 'at', time: '17:00', dayOffset: 0 },
    { kind: 'at', time: '20:00', dayOffset: 0 },
  ];
  const sameDay = seqFrom(exStart, 'Asia/Kolkata', sameDaySpecs);
  assert.equal(civilDateInZone(new Date(sameDay.steps![0].at), 'Asia/Kolkata'), '2026-08-21');
  assert.equal(civilDateInZone(new Date(sameDay.steps![1].at), 'Asia/Kolkata'), '2026-08-21');
  assert.equal(civilDateInZone(new Date(sameDay.steps![2].at), 'Asia/Kolkata'), '2026-08-21');
  assert.ok(new Date(sameDay.steps![0].at) < new Date(sameDay.steps![1].at));
  assert.ok(new Date(sameDay.steps![1].at) < new Date(sameDay.steps![2].at));

  // 4. Walk and terminate
  const walk = seqFrom(exStart, 'Asia/Kolkata', exSpecs);
  let cursor = new Date('2026-08-21T00:00:00.000Z');
  assert.equal(
    computeNextRunAt(walk, 'Asia/Kolkata', cursor, { afterOccurrence: cursor })!.toISOString(),
    ex.steps![0].at,
  );
  cursor = new Date(ex.steps![0].at);
  assert.equal(
    computeNextRunAt(walk, 'Asia/Kolkata', cursor, { afterOccurrence: cursor })!.toISOString(),
    ex.steps![1].at,
  );
  cursor = new Date(ex.steps![1].at);
  assert.equal(
    computeNextRunAt(walk, 'Asia/Kolkata', cursor, { afterOccurrence: cursor })!.toISOString(),
    ex.steps![2].at,
  );
  cursor = new Date(ex.steps![2].at);
  assert.equal(computeNextRunAt(walk, 'Asia/Kolkata', cursor, { afterOccurrence: cursor }), null);

  // 5. Unsorted steps
  const sorted = seqFrom(exStart, 'Asia/Kolkata', exSpecs);
  const shuffled: WorkflowSchedule = {
    frequency: 'sequence',
    startAt: exStart,
    steps: [sorted.steps![2], sorted.steps![0], sorted.steps![1]],
  };
  assert.equal(
    computeNextRunAt(shuffled, 'Asia/Kolkata', new Date('2026-08-21T00:00:00.000Z'))!.toISOString(),
    sorted.steps![0].at,
  );

  // 6. Malformed instant
  assert.throws(
    () =>
      computeNextRunAt(
        {
          frequency: 'sequence',
          steps: [{ spec: { kind: 'after', minutes: 60, from: 'previous' }, at: 'not-a-date' }],
        },
        'Asia/Kolkata',
        new Date(),
      ),
    /invalid sequence step instant/,
  );

  // 7. Empty steps
  assert.throws(
    () => computeNextRunAt({ frequency: 'sequence', steps: [] }, 'Asia/Kolkata', new Date()),
    /no steps/,
  );

  // 8. endDate ignored
  const withEndDate: WorkflowSchedule = { ...ex, endDate: '2020-01-01' };
  assert.equal(
    computeNextRunAt(withEndDate, 'Asia/Kolkata', new Date('2026-08-21T00:00:00.000Z'))!.toISOString(),
    ex.steps![0].at,
  );

  // 9. DST across a sequence
  const dstStart = '2026-03-07T15:00:00.000Z';
  const dstSpecs: StepSpec[] = [
    { kind: 'at', time: '10:00', dayOffset: 0 },
    { kind: 'at', time: '10:00', dayOffset: 1 },
  ];
  const dstSeq = seqFrom(dstStart, 'America/New_York', dstSpecs);
  const nyFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const step of dstSeq.steps!) {
    const parts: Record<string, string> = {};
    for (const p of nyFmt.formatToParts(new Date(step.at))) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    assert.equal(Number(parts.hour), 10);
    assert.equal(Number(parts.minute), 0);
  }

  // 10. Fall-back determinism
  const fbSpec: StepSpec[] = [{ kind: 'at', time: '01:30', dayOffset: 0 }];
  const fbStart = '2026-11-01T04:00:00.000Z';
  const fb1 = materializeSequence(new Date(fbStart), 'America/New_York', fbSpec);
  const fb2 = materializeSequence(new Date(fbStart), 'America/New_York', fbSpec);
  assert.equal(fb1[0].toISOString(), fb2[0].toISOString());

  // 11. Timezone independence
  const tzSeq = seqFrom(exStart, 'Asia/Kolkata', exSpecs);
  assert.equal(
    computeNextRunAt(tzSeq, 'UTC', new Date('2026-08-21T00:00:00.000Z'))!.toISOString(),
    computeNextRunAt(tzSeq, 'Asia/Kolkata', new Date('2026-08-21T00:00:00.000Z'))!.toISOString(),
  );

  // 12. Leap day
  const leapStart = '2028-02-28T04:30:00.000Z';
  const leapSpecs: StepSpec[] = [{ kind: 'at', time: '09:00', dayOffset: 1 }];
  const leap = seqFrom(leapStart, 'Asia/Kolkata', leapSpecs);
  assert.equal(civilDateInZone(new Date(leap.steps![0].at), 'Asia/Kolkata'), '2028-02-29');

  // 13. Zero-delay
  const zeroOk = materializeSequence(new Date(exStart), 'Asia/Kolkata', [
    { kind: 'after', minutes: 0, from: 'previous' },
  ]);
  assert.equal(zeroOk[0].toISOString(), exStart);
  assert.throws(
    () =>
      materializeSequence(new Date(exStart), 'Asia/Kolkata', [
        { kind: 'after', minutes: 60, from: 'previous' },
        { kind: 'after', minutes: 0, from: 'previous' },
      ]),
    /minutes must be >= 1/,
  );

  // 14. Duplicate instants
  assert.throws(
    () =>
      materializeSequence(new Date(exStart), 'Asia/Kolkata', [
        { kind: 'after', minutes: 60, from: 'start' },
        { kind: 'after', minutes: 60, from: 'start' },
      ]),
    /resolves before the step it follows/,
  );

  // 15. No burst on a sequence
  const burstStart = '2026-08-21T04:30:00.000Z';
  const burstSpecs: StepSpec[] = [
    { kind: 'after', minutes: 0, from: 'previous' },
    { kind: 'after', minutes: 30, from: 'previous' },
    { kind: 'after', minutes: 30, from: 'previous' },
  ];
  const burstSeq = seqFrom(burstStart, 'Asia/Kolkata', burstSpecs);
  const burstNow = new Date(burstSeq.steps![2].at);
  burstNow.setMinutes(burstNow.getMinutes() + 5);
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  let burstBacklog: Date | null = new Date(burstSeq.steps![0].at);
  let burstSends = 0;
  for (let tick = 0; tick < 6 && burstBacklog; tick++) {
    const plan = planCatchUp(burstSeq, 'Asia/Kolkata', burstBacklog, burstNow, THREE_HOURS_MS);
    if (plan.action === 'wait' || plan.action === 'complete') break;
    const occurrence = plan.action === 'run' ? plan.occurrence : plan.runNow;
    if (!occurrence) {
      burstBacklog = plan.action === 'skip' ? plan.nextRunAt : null;
      continue;
    }
    burstSends++;
    burstBacklog = computeNextRunAt(burstSeq, 'Asia/Kolkata', burstNow, { afterOccurrence: occurrence });
  }
  assert.equal(burstSends, 1, 'a sequence backlog must still produce exactly ONE send');

  const tplAt = '2026-08-21T04:30:00.000Z';
  const tplSeq: WorkflowSchedule = {
    frequency: 'sequence',
    steps: [
      { spec: { kind: 'after', minutes: 0, from: 'start' }, at: tplAt, templateId: 't1' },
      { spec: { kind: 'after', minutes: 30, from: 'previous' }, at: '2026-08-21T05:00:00.000Z', templateId: 't2' },
    ],
  };
  assert.equal(stepTemplateId(tplSeq, new Date(tplAt)), 't1');
  assert.equal(stepTemplateId({ frequency: 'daily', time: '10:00' }, new Date(tplAt)), undefined);

  console.log('recurrence self-check passed');
}
