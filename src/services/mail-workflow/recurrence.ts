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

function utcFromZoned(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
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
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

function lastDayOfMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function isoDowFromYmd(y: number, mo: number, d: number): number {
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

function addCivilDays(y: number, mo: number, d: number, days: number) {
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

export function computeNextRunAt(
  schedule: WorkflowSchedule,
  timezone: string,
  fromUtc: Date,
  opts?: { afterOccurrence?: Date }
): Date {
  const [hStr, mStr] = schedule.time.split(':');
  const h = Number(hStr);
  const mi = Number(mStr);
  const after = opts?.afterOccurrence ?? fromUtc;

  const start = civilDateInZone(after, timezone);
  let { year: y, month: mo, day: d } = {
    year: Number(start.slice(0, 4)),
    month: Number(start.slice(5, 7)),
    day: Number(start.slice(8, 10)),
  };

  for (let i = 0; i < 400; i++) {
    if (dayMatchesSchedule(schedule, y, mo, d)) {
      const candidate = utcFromZoned(timezone, y, mo, d, h, mi);
      if (candidate > after) return candidate;
    }
    ({ year: y, month: mo, day: d } = addCivilDays(y, mo, d, 1));
  }
  throw new Error('no next run within 400 days');
}

if (process.argv[1]?.endsWith('recurrence.ts')) {
  const weekly = { frequency: 'weekly' as const, time: '10:00', dayOfWeek: 1 };
  const next = computeNextRunAt(weekly, 'Asia/Kolkata', new Date('2026-08-21T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-08-24T04:30:00.000Z');

  const monthly = { frequency: 'monthly' as const, time: '10:00', dayOfMonth: 31 };
  const feb = computeNextRunAt(monthly, 'Asia/Kolkata', new Date('2026-01-31T04:30:00Z'));
  assert.equal(civilDateInZone(feb, 'Asia/Kolkata'), '2026-02-28');

  const daily = { frequency: 'daily' as const, time: '10:00', endDate: '2026-08-24' };
  assert.equal(endDateReached(daily, 'Asia/Kolkata', new Date('2026-08-24T04:30:00Z')), false);
  assert.equal(endDateReached(daily, 'Asia/Kolkata', new Date('2026-08-25T04:30:00Z')), true);

  const ny = computeNextRunAt(
    { frequency: 'daily', time: '02:30' },
    'America/New_York',
    new Date('2026-03-07T10:00:00Z')
  );
  assert.ok(ny > new Date('2026-03-07T10:00:00Z'));
  console.log('recurrence self-check passed');
}
