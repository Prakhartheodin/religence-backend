import assert from 'node:assert/strict';
import type { WorkflowSchedule } from './contract.js';
import { addCivilDays, civilDateInZone, utcFromZoned } from './recurrence.js';

/**
 * Deterministic natural-language → schedule parsing.
 *
 * This runs BEFORE the LLM. Everything here is exact and timezone-correct, so the model
 * never gets a chance to invent a time — and an explicit date/time in the message always
 * beats a vague "send it now".
 */

const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7,
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9:\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDayPartClock(text: string): { hour: number; minute: number } | null {
  const match = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s+(?:in\s+(?:the\s+)?)?(morning|afternoon|evening)\b/i,
  );
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const part = match[3].toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return null;
  }
  if (part === 'afternoon' || part === 'evening') {
    if (hour !== 12) hour += 12;
  } else if (part === 'morning' && hour === 12) {
    hour = 0;
  }
  return { hour, minute };
}

export function parseClock(text: string): { hour: number; minute: number } | null {
  const dayPart = parseDayPartClock(text);
  if (dayPart) return dayPart;

  // Require am/pm or a colon: a bare number is a template name ("Follow-up 1"), not a time.
  const match =
    text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
    ?? text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

function hhmm(clock: { hour: number; minute: number }): string {
  return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

function civilToday(timezone: string, now: Date): { y: number; m: number; d: number } {
  const iso = civilDateInZone(now, timezone);
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

function civilShift(
  timezone: string,
  now: Date,
  days: number,
): { y: number; m: number; d: number } {
  const t = civilToday(timezone, now);
  const s = addCivilDays(t.y, t.m, t.d, days);
  return { y: s.year, m: s.month, d: s.day };
}

function isoDowOf(y: number, m: number, d: number): number {
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

function instant(
  timezone: string,
  ymd: { y: number; m: number; d: number },
  clock: { hour: number; minute: number },
): string {
  return utcFromZoned(timezone, ymd.y, ymd.m, ymd.d, clock.hour, clock.minute).toISOString();
}

export function hasRecurringLanguage(text: string): boolean {
  const t = normalize(text);
  return /\b(every|each|daily|weekly|monthly|recurring|repeat|weekdays)\b/.test(t);
}

const IMMEDIATE_RE =
  /\b(send (it |this )?now|now send (it)?|send immediately|right now|right away|immediately|asap|straight away)\b/;

/** True when the message asks to send at once, with no time qualifier anywhere. */
export function isImmediatePhrase(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (/^(now|asap)$/.test(t)) return true;
  return IMMEDIATE_RE.test(t);
}

/** Loose "the user is talking about sending once" signal, used only alongside a clock. */
function hasOnceLanguage(text: string): boolean {
  const t = normalize(text);
  return /\b(once|one time|one-time|one off|just this once|send it|send this|send)\b/.test(t);
}

export type ParsedWhen = {
  schedule: WorkflowSchedule;
  /** True when the phrasing was explicit enough to override anything the LLM says. */
  explicit: boolean;
};

/**
 * Parse a "when" out of free text. Returns null when the text carries no timing at all.
 * `now` is injected for testability.
 */
export function parseWhen(
  text: string,
  timezone: string,
  now: Date = new Date(),
): ParsedWhen | null {
  const raw = text.trim();
  const t = normalize(raw);
  if (!t) return null;

  const clock = parseClock(raw);
  const recurring = hasRecurringLanguage(t);

  // ---------- recurring ----------
  if (recurring) {
    const time = hhmm(clock ?? { hour: 9, minute: 0 });

    const monthDay = t.match(/\b(?:on the )?(\d{1,2})(?:st|nd|rd|th)\b/);
    if (/\b(month|monthly)\b/.test(t)) {
      const dayOfMonth = monthDay ? Number(monthDay[1]) : civilToday(timezone, now).d;
      if (dayOfMonth >= 1 && dayOfMonth <= 31) {
        return { schedule: { frequency: 'monthly', time, dayOfMonth }, explicit: true };
      }
    }

    for (const [name, dow] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}s?\\b`).test(t)) {
        return { schedule: { frequency: 'weekly', time, dayOfWeek: dow }, explicit: true };
      }
    }

    if (/\b(week|weekly)\b/.test(t)) {
      // "every week" with no day named: keep today's weekday so the answer is deterministic.
      const today = civilToday(timezone, now);
      return {
        schedule: {
          frequency: 'weekly',
          time,
          dayOfWeek: isoDowOf(today.y, today.m, today.d),
        },
        explicit: true,
      };
    }

    if (/\b(day|daily|every day)\b/.test(t)) {
      return { schedule: { frequency: 'daily', time }, explicit: true };
    }

    if (clock) return { schedule: { frequency: 'daily', time }, explicit: true };
    return null;
  }

  // ---------- one-time with an explicit calendar date ----------
  const isoDate = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    const ymd = {
      y: Number(isoDate[1]),
      m: Number(isoDate[2]),
      d: Number(isoDate[3]),
    };
    return {
      schedule: {
        frequency: 'once',
        runAt: instant(timezone, ymd, clock ?? { hour: 9, minute: 0 }),
      },
      explicit: true,
    };
  }

  // ---------- one-time relative days ----------
  if (/\btomorrow\b/.test(t)) {
    return {
      schedule: {
        frequency: 'once',
        runAt: instant(timezone, civilShift(timezone, now, 1), clock ?? { hour: 9, minute: 0 }),
      },
      explicit: true,
    };
  }

  if (/\btoday\b/.test(t) && clock) {
    return {
      schedule: { frequency: 'once', runAt: instant(timezone, civilShift(timezone, now, 0), clock) },
      explicit: true,
    };
  }

  // ---------- one-time named weekday ("on Friday at 3 PM") ----------
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${name}\\b`).test(t)) continue;
    const today = civilToday(timezone, now);
    const todayDow = isoDowOf(today.y, today.m, today.d);
    let delta = (dow - todayDow + 7) % 7;
    const useClock = clock ?? { hour: 9, minute: 0 };
    if (delta === 0) {
      // Same weekday: today if the time is still ahead, otherwise next week.
      const candidate = instant(timezone, civilShift(timezone, now, 0), useClock);
      if (new Date(candidate).getTime() > now.getTime()) {
        return { schedule: { frequency: 'once', runAt: candidate }, explicit: true };
      }
      delta = 7;
    }
    if (/\bnext\b/.test(t) && delta < 7) delta += 7;
    return {
      schedule: {
        frequency: 'once',
        runAt: instant(timezone, civilShift(timezone, now, delta), useClock),
      },
      explicit: true,
    };
  }

  // ---------- bare clock ("at 5pm") ----------
  if (clock && hasOnceLanguage(t)) {
    const todayAt = instant(timezone, civilShift(timezone, now, 0), clock);
    const runAt = new Date(todayAt).getTime() > now.getTime()
      ? todayAt
      : instant(timezone, civilShift(timezone, now, 1), clock);
    return { schedule: { frequency: 'once', runAt }, explicit: true };
  }

  // ---------- "send it now" ----------
  if (isImmediatePhrase(raw)) {
    return { schedule: { frequency: 'once', runAt: now.toISOString() }, explicit: false };
  }

  return null;
}

function looksLikeTimeCorrection(text: string): boolean {
  const t = normalize(text);
  return (
    /\b(make it|change(?:\s+it)?\s+to|set it to|instead|rather|move it to|update it to)\b/.test(t)
    || /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t)
    || /\b\d{1,2}\s+(?:in\s+(?:the\s+)?)?(morning|afternoon|evening)\b/.test(t)
  );
}

function onceRunAtForClock(
  timezone: string,
  clock: { hour: number; minute: number },
  civil: { y: number; m: number; d: number },
  now: Date,
): string {
  const candidate = instant(timezone, civil, clock);
  if (new Date(candidate).getTime() > now.getTime()) return candidate;
  const today = civilToday(timezone, now);
  const todayAt = instant(timezone, today, clock);
  if (new Date(todayAt).getTime() > now.getTime()) return todayAt;
  return instant(timezone, civilShift(timezone, now, 1), clock);
}

/**
 * Apply a bare clock correction ("make it 3pm", "1 in the afternoon") when parseWhen
 * returns null — common while editing an existing preview.
 */
export function parseTimeCorrection(
  text: string,
  existing: WorkflowSchedule | null | undefined,
  timezone: string,
  now: Date = new Date(),
): ParsedWhen | null {
  const preprocessed = text.replace(/\b(?:12\s+)?noon\b/gi, '12 pm');
  const clock = parseClock(preprocessed);
  if (!clock || !looksLikeTimeCorrection(preprocessed)) return null;

  if (existing?.frequency === 'daily') {
    return { schedule: { frequency: 'daily', time: hhmm(clock) }, explicit: true };
  }
  if (existing?.frequency === 'weekly' && existing.dayOfWeek != null) {
    return {
      schedule: { frequency: 'weekly', time: hhmm(clock), dayOfWeek: existing.dayOfWeek },
      explicit: true,
    };
  }
  if (existing?.frequency === 'monthly' && existing.dayOfMonth != null) {
    return {
      schedule: { frequency: 'monthly', time: hhmm(clock), dayOfMonth: existing.dayOfMonth },
      explicit: true,
    };
  }

  if (existing?.frequency === 'once' && existing.runAt) {
    const prev = new Date(existing.runAt);
    const civil = Number.isNaN(prev.getTime())
      ? civilToday(timezone, now)
      : {
          y: Number(civilDateInZone(prev, timezone).slice(0, 4)),
          m: Number(civilDateInZone(prev, timezone).slice(5, 7)),
          d: Number(civilDateInZone(prev, timezone).slice(8, 10)),
        };
    return {
      schedule: {
        frequency: 'once',
        runAt: onceRunAtForClock(timezone, clock, civil, now),
      },
      explicit: true,
    };
  }

  const todayAt = instant(timezone, civilShift(timezone, now, 0), clock);
  const runAt = new Date(todayAt).getTime() > now.getTime()
    ? todayAt
    : instant(timezone, civilShift(timezone, now, 1), clock);
  return { schedule: { frequency: 'once', runAt }, explicit: true };
}

if (process.argv[1]?.endsWith('chat-time.ts')) {
  const tz = 'Asia/Kolkata';
  // Tue 25 Aug 2026, 10:30 IST
  const now = new Date('2026-08-25T05:00:00.000Z');
  const when = (s: string) => parseWhen(s, tz, now);

  // clock parsing must ignore bare numbers
  assert.equal(parseClock('Follow-up 1'), null);
  assert.deepEqual(parseClock('at 9am'), { hour: 9, minute: 0 });
  assert.deepEqual(parseClock('at 5 pm'), { hour: 17, minute: 0 });
  assert.deepEqual(parseClock('at 14:30'), { hour: 14, minute: 30 });
  assert.deepEqual(parseClock('at 12am'), { hour: 0, minute: 0 });
  assert.deepEqual(parseClock('at 12pm'), { hour: 12, minute: 0 });
  assert.deepEqual(parseClock('1 in the afternoon'), { hour: 13, minute: 0 });
  assert.deepEqual(parseClock('make it 1 in afternoon'), { hour: 13, minute: 0 });
  assert.deepEqual(parseClock('7 in the evening'), { hour: 19, minute: 0 });

  // recurring
  assert.deepEqual(when('every day at 2 PM')!.schedule, { frequency: 'daily', time: '14:00' });
  assert.deepEqual(when('daily at 14:00')!.schedule, { frequency: 'daily', time: '14:00' });
  assert.deepEqual(
    when('every Monday at 10 AM')!.schedule,
    { frequency: 'weekly', time: '10:00', dayOfWeek: 1 },
  );
  assert.deepEqual(
    when('every Friday at 3 PM')!.schedule,
    { frequency: 'weekly', time: '15:00', dayOfWeek: 5 },
  );
  assert.deepEqual(
    when('every month on the 5th at 9am')!.schedule,
    { frequency: 'monthly', time: '09:00', dayOfMonth: 5 },
  );

  // one-time: explicit date/time ALWAYS wins over "send it"
  const tomorrow = when('send it to Rahul tomorrow at 9')!;
  assert.equal(tomorrow.schedule.frequency, 'once');
  assert.equal(tomorrow.schedule.runAt, '2026-08-26T03:30:00.000Z', 'tomorrow 09:00 IST');

  const at5 = when('send this to Bob at 5pm')!;
  assert.equal(at5.schedule.frequency, 'once');
  assert.equal(at5.schedule.runAt, '2026-08-25T11:30:00.000Z', 'today 17:00 IST');

  // bare clock already past rolls to tomorrow rather than firing instantly
  const at9 = when('send it at 9am')!;
  assert.equal(at9.schedule.runAt, '2026-08-26T03:30:00.000Z', '09:00 already passed today');

  // named weekday
  const friday = when('send it Friday at 3 PM')!;
  assert.equal(friday.schedule.frequency, 'once');
  assert.equal(friday.schedule.runAt, '2026-08-28T09:30:00.000Z', 'Fri 28 Aug 15:00 IST');

  // "every Friday" is recurring, not a one-off
  assert.equal(when('send it every Friday at 3 PM')!.schedule.frequency, 'weekly');

  // iso date
  assert.equal(when('send on 2026-09-01 at 11:15')!.schedule.runAt, '2026-09-01T05:45:00.000Z');

  // send now
  const nowWhen = when('send it now')!;
  assert.equal(nowWhen.schedule.frequency, 'once');
  assert.equal(nowWhen.explicit, false, '"now" is not explicit — a real time overrides it');
  assert.equal(when('now')!.schedule.frequency, 'once');

  // no timing at all
  assert.equal(when('use the follow up template'), null);
  assert.equal(when('Prakhar Sharma'), null);
  assert.equal(when('yes'), null);

  assert.equal(isImmediatePhrase('now'), true);
  assert.equal(isImmediatePhrase('send it now'), true);
  assert.equal(isImmediatePhrase('send it tomorrow'), false);

  // timezone correctness: the same words in a different zone give a different instant
  const ny = parseWhen('send it tomorrow at 9am', 'America/New_York', now)!;
  assert.equal(ny.schedule.runAt, '2026-08-26T13:00:00.000Z');

  // bare clock corrections while editing a preview
  assert.equal(parseWhen('make it 3pm', tz, now), null, 'parseWhen ignores bare corrections');
  const pastOnce = { frequency: 'once' as const, runAt: '2023-10-05T13:00:00.000Z' };
  const fixPast = parseTimeCorrection('Actually, make it 1 in afternoon', pastOnce, tz, now)!;
  assert.equal(fixPast.schedule.frequency, 'once');
  assert.equal(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    }).format(new Date(fixPast.schedule.runAt!)),
    '1:00 PM',
  );
  const fixPm = parseTimeCorrection('1 pm', pastOnce, tz, now)!;
  assert.equal(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    }).format(new Date(fixPm.schedule.runAt!)),
    '1:00 PM',
  );

  console.log('chat-time self-check passed');
}
