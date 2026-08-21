# Mail Sequences — Implementation Guide

Companion to `docs/mail-sequence-spec.md`. That document is the *design*; this one is the
*execution plan*, written so each phase can be handed to Cursor Composer as a single
self-contained prompt.

**Six phases (0–5). Phase 0 is done.** Run them in order — each assumes the previous one
landed and its checks are green.

## How to run a phase

1. Attach **both** `docs/mail-sequence-spec.md` and this file to the Composer context.
2. Paste **§0 Ground rules**, then the phase prompt, in one message.
3. When it finishes, run the phase's verification commands yourself. Do not trust a
   summary that says checks passed — run them.
4. Only move on when the phase's Definition of Done is fully green.

Do not run two phases in one Composer session. Each phase changes the meaning of code the
next one reads, and a single long session drifts.

---

# §0 Ground rules

Paste this block at the top of **every** phase prompt.

```
REPO CONVENTIONS — follow exactly, these override your defaults.

- TypeScript, ESM, NodeNext. Every relative import MUST end in `.js`
  (e.g. `import { x } from './recurrence.js'`) even though the file is `.ts`.
- There is NO test framework. Tests are `assert`-based blocks at the BOTTOM of the file
  they test, gated by:
      if (process.argv[1]?.endsWith('<filename>.ts')) { ... }
  Use `import assert from 'node:assert/strict'`. Do NOT add jest/vitest/mocha.
  Do NOT create `*.test.ts` files. Do NOT create a `__tests__` directory.
- Add NO new npm dependencies. None. Use stdlib and what is already imported.
- Create NO new files unless the prompt names them explicitly.
- Do NOT reformat, reorder, or "clean up" code you were not asked to change.
  Do NOT change import ordering. Do NOT add or remove semicolons elsewhere.
- Comments explain WHY, not what. Where you take a deliberate shortcut with a known
  ceiling, mark it `// ponytail: <ceiling>, <upgrade path>`.
- Match the surrounding style: 2-space indent, single quotes, trailing commas in
  multiline literals, 100-col soft wrap.

VERIFY BEFORE YOU REPORT DONE — run these and paste real output:
    npx tsc --noEmit
    npm run check:mail
Both must be clean. `check:mail` must print "all 10 self-checks passed".

If a change would break an existing assertion, STOP and explain which one and why.
Do not edit an existing assertion to make it pass unless the prompt tells you to.
```

---

# Phase 1 — Engine and model

**Goal:** a sequence schedule can be represented, persisted, materialized, and walked.
**Nothing user-visible.** No chat path can produce a sequence after this phase.

### Files

| File | Change |
|---|---|
| `src/services/mail-workflow/contract.ts` | types + `parseContract` branch |
| `src/services/mail-workflow/recurrence.ts` | `materializeSequence` + `computeNextRunAt` branch + tests |
| `src/services/mail-workflow/scheduler.ts` | `exhaustedByLimits` guard + test |
| `src/services/mail-workflow/workflow.service.ts` | schedule mapping + `scheduleLabel` |
| `src/models/mail-workflow.model.ts` | enum + `startAt` + `steps` |

**Do NOT touch:** `chat-parser.ts`, `chat-time.ts`, `chat-draft.ts`, `send-executor.ts`,
`mail-workflow-run.model.ts`, anything under `religance/` (the frontend).

### 1.1 `contract.ts` — types

Change `Frequency`:

```ts
export type Frequency = 'once' | 'daily' | 'weekly' | 'monthly' | 'sequence';
```

Add above `WorkflowSchedule`:

```ts
/** How one step in a sequence is timed. */
export type StepSpec =
  /** Relative: "after 1 hour", "3 days later". */
  | { kind: 'after'; minutes: number; from: 'start' | 'previous' }
  /** Absolute wall clock in the workflow timezone: "at 2pm", "9am on day 3". */
  | { kind: 'at'; time: string; dayOffset: number };

export type SequenceStep = {
  spec: StepSpec;
  /** Materialized ISO-8601 UTC instant. The scheduler reads only this. */
  at: string;
  /** Absent = inherit the workflow's templateId. */
  templateId?: string;
};
```

Add two optional fields to `WorkflowSchedule`, leaving every existing field untouched:

```ts
  /** sequence only: the anchor the steps were materialized from. Never moves. */
  startAt?: string;
  /** sequence only: ordered, materialized steps. */
  steps?: SequenceStep[];
```

### 1.2 `contract.ts` — `parseContract` schedule branch

**This is a blocker.** The schedule parser currently runs, for anything that is not `once`:

```ts
  const time = String(s.time ?? '');
  if (!HHMM.test(time)) throw new WorkflowError('SCHEDULE_INVALID', 'time must be HH:mm');
```

A sequence has no `time`, so every sequence is rejected today. Insert a `sequence` branch
**immediately after** the existing `if (frequency === 'once') { ... }` block and **before**
that `const time = ...` line.

The branch validates **structure only** — shape, ISO validity, ordering. Bounds like step
count, minimum gap and total span are policy and belong to phase 2's `sanitizeSchedule`.
Do not add them here.

```ts
  if (frequency === 'sequence') {
    const rawSteps = Array.isArray(s.steps) ? s.steps : [];
    if (!rawSteps.length) {
      throw new WorkflowError('SCHEDULE_INVALID', 'a sequence needs at least one step');
    }
    const steps: SequenceStep[] = rawSteps.map((entry, i) => {
      const step = entry as Record<string, unknown>;
      const at = parseIsoInstant(step.at, `schedule.steps[${i}].at`);
      const rawSpec = (step.spec ?? {}) as Record<string, unknown>;
      const kind = String(rawSpec.kind ?? '');
      let spec: StepSpec;
      if (kind === 'after') {
        const minutes = Number(rawSpec.minutes);
        if (!Number.isInteger(minutes) || minutes < 0) {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].minutes must be an integer >= 0`);
        }
        const from = rawSpec.from === 'start' ? 'start' : 'previous';
        spec = { kind: 'after', minutes, from };
      } else if (kind === 'at') {
        const time = String(rawSpec.time ?? '');
        if (!HHMM.test(time)) {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].time must be HH:mm`);
        }
        const dayOffset = Number(rawSpec.dayOffset ?? 0);
        if (!Number.isInteger(dayOffset) || dayOffset < 0) {
          throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].dayOffset must be >= 0`);
        }
        spec = { kind: 'at', time, dayOffset };
      } else {
        throw new WorkflowError('SCHEDULE_INVALID', `steps[${i}].spec.kind must be 'after' or 'at'`);
      }
      const templateId = step.templateId == null ? undefined : String(step.templateId).trim();
      return { spec, at, ...(templateId ? { templateId } : {}) };
    });

    // The stored order IS the send order, so a caller cannot hand us a jumbled list and
    // rely on us to sort it — that would silently change which step is which.
    for (let i = 1; i < steps.length; i++) {
      if (new Date(steps[i].at) <= new Date(steps[i - 1].at)) {
        throw new WorkflowError('SCHEDULE_INVALID', 'sequence steps must be strictly increasing');
      }
    }

    return {
      frequency: 'sequence',
      startAt: parseIsoInstant(s.startAt, 'schedule.startAt'),
      steps,
    };
  }
```

Import `SequenceStep` and `StepSpec` if they are declared later in the file than this
function; otherwise no import is needed (same module).

### 1.3 `recurrence.ts` — `computeNextRunAt` branch

Insert as the **very first statement** of the function body, before the existing
`if (schedule.frequency === 'once')` block.

Placement matters: further down, the function does `String(schedule.time ?? '').split(':')`
and throws `invalid schedule time: undefined`. A sequence has no `time`.

```ts
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
```

Throwing is safe and deliberate: `processDueWorkflow` catches, calls `releaseWorkflow`, and
rethrows; `runSchedulerTick` catches per workflow and logs `scheduler.claim_failed`. The
lease is released and other workflows are unaffected. A silent `null` would not be safe.

`endDate` is deliberately not consulted — `endDateReached` is only called inside the
recurring loop below, and a sequence is bounded by its own list.

### 1.4 `recurrence.ts` — `materializeSequence`

Add as an exported function after `computeNextRunAt`. Import `StepSpec` from
`./contract.js` alongside the existing `WorkflowSchedule` type import.

This owns **time math only**. Policy bounds are phase 2.

```ts
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
```

### 1.5 `scheduler.ts` — `exhaustedByLimits`

A sequence is bounded by its own list. A stray `maxRuns` on the document must not complete
it early. Phase 2 strips `maxRuns` at validation, but the engine must not depend on a later
phase.

```ts
export function exhaustedByLimits(wf: MailWorkflowDocument): boolean {
  const schedule = modelScheduleToContract(wf.schedule);
  // A sequence ends by running out of steps, never by a run count.
  if (schedule.frequency === 'sequence') return false;
  if (schedule.maxRuns != null && wf.runCount >= schedule.maxRuns) return true;
  return false;
}
```

### 1.6 `workflow.service.ts` — mapping and label

`contractScheduleToModel` — add before the final `return`:

```ts
  if (s.frequency === 'sequence') {
    return {
      frequency: 'sequence',
      startAt: s.startAt ? new Date(s.startAt) : null,
      steps: (s.steps ?? []).map((step) => ({ ...step })),
    };
  }
```

`modelScheduleToContract` — add immediately after the existing `once` branch, **before**
the legacy `maxRuns === 1` branch:

```ts
  if (s.frequency === 'sequence') {
    return {
      frequency: 'sequence',
      startAt: s.startAt ? new Date(s.startAt).toISOString() : undefined,
      steps: (s.steps ?? []).map((step) => ({
        spec: step.spec,
        at: new Date(step.at).toISOString(),
        ...(step.templateId ? { templateId: step.templateId } : {}),
      })),
    };
  }
```

Widen `MailWorkflowSchedule` in `src/models/mail-workflow.model.ts` with
`startAt?: Date | null` and `steps?: SequenceStep[]` to match.

`scheduleLabel` — **blocker.** It returns early for `once`, `daily`, `weekly`, then
*assumes* monthly. A sequence reaching it renders "Every month on the 1st at 12:00 AM".
Add immediately after the `once` branch:

```ts
  if (s.frequency === 'sequence') {
    const n = s.steps?.length ?? 0;
    // ponytail: a count, not a step table. The card renders the real list in phase 2.
    return n === 1 ? '1 send' : `${n} sends`;
  }
```

### 1.7 `mail-workflow.model.ts`

In `scheduleSchema`:

```ts
    frequency: {
      type: String,
      required: true,
      // 'sequence' must stay in this enum FOREVER, even if sequences are disabled. Once a
      // document holds it, removing the value makes that document unsaveable — it can no
      // longer be paused or cancelled, only deleted.
      enum: ['once', 'daily', 'weekly', 'monthly', 'sequence'],
    },
```

Add a step subdocument above `scheduleSchema` and wire it in:

```ts
const sequenceStepSchema = new mongoose.Schema(
  {
    spec: { type: mongoose.Schema.Types.Mixed, required: true },
    at: { type: Date, required: true },
    templateId: { type: String },
  },
  { _id: false }
);
```

then inside `scheduleSchema`:

```ts
    startAt: { type: Date, default: null },
    steps: { type: [sequenceStepSchema], default: undefined },
```

`default: undefined` matters — `default: []` would write an empty array onto every existing
non-sequence schedule.

### 1.8 Tests

Add to the existing `if (process.argv[1]?.endsWith('recurrence.ts'))` block, before the
final `console.log`. Build a helper so the cases read cleanly:

```ts
  const seqFrom = (startIso: string, tzName: string, specs: StepSpec[]): WorkflowSchedule => {
    const at = materializeSequence(new Date(startIso), tzName, specs);
    return {
      frequency: 'sequence',
      startAt: startIso,
      steps: at.map((d, i) => ({ spec: specs[i], at: d.toISOString() })),
    };
  };
```

1. **The §2 example.** From `2026-08-21T04:30:00Z` in `Asia/Kolkata` (10:00 IST) with
   `after 60 previous`, `at 14:00 d0`, `after 120 previous` → `11:00`, `14:00`, `16:00` IST.
   Assert all three exact ISO instants.
2. **Roll-forward.** `at 09:00 d0` following a step at 10:00 IST lands on the NEXT day at
   09:00 IST. Assert the value — this also pins the O(1) roll arithmetic.
3. **Same day, several steps.** `at 14:00 d0`, `at 17:00 d0`, `at 20:00 d0` → three distinct
   ordered instants on one civil date.
4. **Walk and terminate.** `computeNextRunAt` returns each step in turn and `null` after the
   last.
5. **Unsorted steps.** Hand-build a schedule whose `steps` array is shuffled; assert
   `computeNextRunAt` still returns the earliest instant after the cursor.
6. **Malformed instant.** `steps: [{ spec, at: 'not-a-date' }]` → `assert.throws`.
7. **Empty steps.** `{ frequency: 'sequence', steps: [] }` → `assert.throws`.
8. **`endDate` ignored.** A sequence carrying `endDate: '2020-01-01'` still returns its next
   step.
9. **DST across a sequence.** In `America/New_York`, `at 10:00 d0` and `at 10:00 d1` spanning
   2026-03-08 both read back as 10:00 local via `zonedParts`/`civilDateInZone`.
10. **Fall-back determinism.** `at 01:30` on 2026-11-01 in `America/New_York` materializes to
    a stable instant across two calls.
11. **Timezone independence.** Materialize in `Asia/Kolkata`, then call `computeNextRunAt`
    with `'UTC'`; the returned instants are identical.
12. **Leap day.** `at 09:00` with `dayOffset` crossing 2028-02-29 lands on Feb 29.
13. **Zero-delay.** `after 0 previous` as step 1 materializes exactly at `startAt`; as step 2
    it throws.
14. **Duplicate instants.** `after 60 start` twice → throws.
15. **No burst on a sequence.** Drive `planCatchUp` across consecutive ticks over a sequence
    with three due steps 30 minutes apart; assert exactly ONE send. Mirror the existing
    "backlog of fresh occurrences" test directly above it.

In `scheduler.ts`'s self-check block:

16. `exhaustedByLimits` is `false` for a sequence document carrying `maxRuns: 1` and
    `runCount: 5`.

In `contract.ts`'s self-check block:

17. `parseContract` accepts a valid sequence contract and round-trips its steps; it throws
    `SCHEDULE_INVALID` for a sequence with no steps, and for one whose steps are not
    strictly increasing.

In `workflow.service.ts`'s self-check block (create one gated on
`workflow.service.ts` if none exists):

18. `scheduleLabel({ frequency: 'sequence', steps: [...3] }, 'Asia/Kolkata')` returns
    `'3 sends'` and does **not** match `/Every month/`.

### Definition of done — phase 1

- `npx tsc --noEmit` clean
- `npm run check:mail` → "all 10 self-checks passed"
- `npm run check:mail:integration` → "mail-workflow integration check passed"
- `grep -rn "'sequence'" src/services/mail-workflow/chat-parser.ts` returns **nothing** —
  the chat path still cannot produce one
- Every pre-existing assertion passes unedited

---

# Phase 2 — Validation and the confirmation card

**Goal:** a sequence can be validated, previewed, and confirmed without silently changing
what the user approved. Still no chat path produces one — phase 2 is reachable from tests
and from a hand-built contract only.

### Files

| File | Change |
|---|---|
| `src/services/mail-workflow/chat-parser.ts` | `sanitizeSchedule` sequence branch + tests |
| `src/services/mail-workflow/workflow.service.ts` | `PreviewSummary.steps`, `buildPreviewInternal`, confirm re-check in `createWorkflow` |
| `religance/shared/crm/mail-workflow/types.ts` | mirror `PreviewSummary.steps` |
| `religance/shared/crm/mail-workflow/WorkflowConfirmCard.tsx` | step table + generalized staleness |
| `religance/shared/crm/mail-workflow/test_workflow_confirm_card.ts` | new assertions |

**Do NOT touch:** `recurrence.ts`, either model file, `send-executor.ts`, `scheduler.ts`,
or any part of `chat-parser.ts` other than `sanitizeSchedule` and its self-check block.
The conversation flow is phase 4 — do not add questions, gates or prompts here.

### 2.1 `sanitizeSchedule` — policy bounds

Add these constants near the existing `HHMM_RE` / `YMD_RE` declarations:

```ts
const MAX_SEQUENCE_STEPS = 20;
const MIN_STEP_GAP_MINUTES = 5;
const MAX_SEQUENCE_SPAN_DAYS = 365;
```

`MIN_STEP_GAP_MINUTES = 5` because the scheduler ticks every 30s (`src/index.ts:66`) and
runs at most one occurrence per workflow per tick. Tighter gaps do work, but arrive visibly
late, which reads as a bug.

Insert the branch **after** the existing `if (frequency === 'once') { ... }` block and
**before** this line:

```ts
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') return null;
```

`sanitizeSchedule` **returns `null`** on rejection — it does not throw. Keep that. A `null`
leaves `schedule` missing, so the collection flow re-asks, which is the correct outcome for
a sequence the model got wrong.

```ts
  if (frequency === 'sequence') {
    const startAtRaw = String(s.startAt ?? '').trim();
    const startAt = new Date(startAtRaw);
    if (!startAtRaw || Number.isNaN(startAt.getTime())) return null;

    const rawSteps = Array.isArray(s.steps) ? s.steps : [];
    // One step is not a sequence, it is a `once`. Let the caller model it as such.
    if (rawSteps.length < 2 || rawSteps.length > MAX_SEQUENCE_STEPS) return null;

    const specs: StepSpec[] = [];
    const templateIds: Array<string | undefined> = [];
    for (const entry of rawSteps) {
      const step = (entry ?? {}) as Record<string, unknown>;
      const rawSpec = (step.spec ?? {}) as Record<string, unknown>;
      const kind = String(rawSpec.kind ?? '');
      if (kind === 'after') {
        const minutes = Number(rawSpec.minutes);
        if (!Number.isInteger(minutes) || minutes < 0) return null;
        specs.push({ kind: 'after', minutes, from: rawSpec.from === 'start' ? 'start' : 'previous' });
      } else if (kind === 'at') {
        let time = String(rawSpec.time ?? '').trim();
        if (/^\d:\d{2}$/.test(time)) time = `0${time}`;
        if (!HHMM_RE.test(time)) return null;
        const dayOffset = Number(rawSpec.dayOffset ?? 0);
        if (!Number.isInteger(dayOffset) || dayOffset < 0) return null;
        specs.push({ kind: 'at', time, dayOffset });
      } else {
        return null;
      }
      const tid = step.templateId == null ? undefined : String(step.templateId).trim();
      templateIds.push(tid || undefined);
    }

    const timezone = workflowTimezone();
    let instants: Date[];
    try {
      instants = materializeSequence(startAt, timezone, specs);
    } catch {
      // materializeSequence throws on anything structurally impossible — out of order,
      // unplaceable, malformed. A sequence is accepted whole or not at all; there is no
      // partial credit, because a repaired sequence is a different plan than the one asked
      // for and nobody would be told.
      return null;
    }

    for (let i = 1; i < instants.length; i++) {
      if (instants[i].getTime() - instants[i - 1].getTime() < MIN_STEP_GAP_MINUTES * 60_000) {
        return null;
      }
    }
    const spanMs = instants[instants.length - 1].getTime() - startAt.getTime();
    if (spanMs > MAX_SEQUENCE_SPAN_DAYS * 24 * 60 * 60 * 1000) return null;

    // The user scoped the request to one day ("send 3 mails today"). materializeSequence
    // rolls a step that would land before its predecessor, which is right in general and
    // wrong here — it would quietly move the third mail to tomorrow.
    if (s.sameDay === true) {
      const day0 = civilDateInZone(startAt, timezone);
      if (instants.some((d) => civilDateInZone(d, timezone) !== day0)) return null;
    }

    // endDate and maxRuns are stripped on purpose: the step list IS the bound, and a stray
    // maxRuns would make exhaustedByLimits complete the sequence early.
    return {
      frequency: 'sequence',
      startAt: startAt.toISOString(),
      steps: instants.map((d, i) => ({
        spec: specs[i],
        at: d.toISOString(),
        ...(templateIds[i] ? { templateId: templateIds[i] } : {}),
      })),
    };
  }
```

New imports in `chat-parser.ts`: `materializeSequence` and `civilDateInZone` from
`./recurrence.js`, and the `StepSpec` type from `./contract.js`. `workflowTimezone` is
already imported.

**Note `sameDay` is consumed here and discarded.** It never reaches `WorkflowSchedule` and
is never persisted — it is a property of the request, not of the schedule. Do not add it to
the contract type.

### 2.2 Confirm-time re-check — blocking

A sequence's instants are frozen at preview. `firstRunAt` resolves a sequence to the first
step **strictly after now**, so any step that passed while the card sat on screen is
silently dropped: the card promises 3 sends, 2 happen, nothing says so.

In `createWorkflow` (`workflow.service.ts`), find:

```ts
      if (preflight.sendAllowed && opts.confirmed) {
        const nextRunAt = firstRunAt(schedule, timezone);
```

Insert **before** `const nextRunAt`:

```ts
        // Frozen instants (spec §4) mean a card left sitting can have steps in the past by
        // the time it is confirmed. firstRunAt would skip them without a word, delivering a
        // different plan than the one on screen. Refuse and let the user re-state.
        if (schedule.frequency === 'sequence') {
          const passed = (schedule.steps ?? []).filter((step) => new Date(step.at) <= new Date());
          if (passed.length) {
            const when = passed
              .map((step) => singleRunLabel(step.at, timezone))
              .join(', ');
            throw new WorkflowError(
              'SCHEDULE_INVALID',
              `${passed.length === 1 ? 'One of those sends was' : `${passed.length} of those sends were`} due before you confirmed (${when}). Tell me new times and I'll rebuild the sequence.`,
            );
          }
        }
```

`singleRunLabel` is already defined in this file at `workflow.service.ts:84`.

The all-past case already surfaces through `buildPreviewInternal`'s existing
`'that schedule has no upcoming send'` guard. Leave that guard alone.

### 2.3 `PreviewSummary.steps`

Add to the type at `workflow.service.ts:125`, after `nextSendAt`:

```ts
  /** sequence only: one row per step, in send order. Absent for every other frequency. */
  steps?: Array<{ index: number; at: string; templateName: string; passed: boolean }>;
```

In `buildPreviewInternal`, after `const rendered = renderLeadMessage(...)` and before the
returned object literal:

```ts
  const nowMs = Date.now();
  const steps =
    schedule.frequency === 'sequence'
      ? (schedule.steps ?? []).map((step, i) => ({
          index: i + 1,
          at: new Date(step.at).toISOString(),
          // ponytail: every step shows the workflow template until phase 3 gives steps
          // their own. Read step.templateId here once that lands.
          templateName: template.name,
          passed: new Date(step.at).getTime() <= nowMs,
        }))
      : undefined;
```

and add `...(steps ? { steps } : {}),` to the returned object.

Mirror the type addition in `religance/shared/crm/mail-workflow/types.ts`.

### 2.4 The card

In `WorkflowConfirmCard.tsx`, add next to the existing `sendTimeHasPassed`:

```tsx
/** The first step that has not fired yet — what the card's timer should target. */
export function nextUnpassedStep(
  preview: PreviewSummary,
  now = Date.now(),
): { index: number; at: string } | null {
  return preview.steps?.find((s) => new Date(s.at).getTime() > now) ?? null;
}

/**
 * True when every step of a sequence is already behind us. Confirming then would fire the
 * whole list at once, so the button has to stop being clickable rather than explain itself.
 */
export function allStepsPassed(preview: PreviewSummary, now = Date.now()): boolean {
  const steps = preview.steps;
  if (!steps?.length) return false;
  return steps.every((s) => new Date(s.at).getTime() <= now);
}
```

Generalize the existing `useEffect` timer: it currently keys on `preview.nextSendAt` for a
one-time card. When `preview.steps` is present, target `nextUnpassedStep(preview)?.at`
instead. Keep the existing `MAX_TIMEOUT_MS` clamp and the self-terminating single-timer
shape — do **not** introduce polling.

When `preview.steps` is present, replace the `{once ? "Sends at" : "First send"}` block with
a step table:

```
Sequence — 3 sends
  1.  Today,  2:00 PM   First Introduction
  2.  Today,  5:00 PM   First Introduction
  3.  Today,  8:00 PM   Follow-up 1
```

A passed step renders `Immediately — 2:00 PM has passed`, matching the existing one-time
wording. The header stays "Confirm recurring email" and the button stays
"Confirm & Schedule".

Disable Confirm when `allStepsPassed(preview)` and show why.

### 2.5 Tests

`chat-parser.ts` self-check block — every one asserts `sanitizeSchedule(...)` is `null`:

19. Fewer than 2 steps
20. More than `MAX_SEQUENCE_STEPS`
21. A gap below `MIN_STEP_GAP_MINUTES`
22. A span over `MAX_SEQUENCE_SPAN_DAYS`
23. A step whose `spec.kind` is neither `after` nor `at`
24. A malformed `startAt`
25. `sameDay: true` with a step that rolls to the next day
26. A **valid** sequence round-trips: 3 steps, strictly increasing, `endDate` and `maxRuns`
    present in the input and **absent** from the output

`workflow.service.ts` self-check block:

27. The confirm re-check throws `SCHEDULE_INVALID` when a step is in the past, and the
    message names how many
28. It does not throw when every step is in the future

`test_workflow_confirm_card.ts`:

29. `nextUnpassedStep` skips passed steps and returns the first future one
30. `allStepsPassed` is `false` for a mixed sequence, `true` when all are past, and `false`
    when `steps` is absent — a non-sequence card must never disable its own button

### Definition of done — phase 2

- `npx tsc --noEmit` clean in **both** `religence-backend/` and `religance/`
- `npm run check:mail` → "all 10 self-checks passed"
- `npm run check:mail:integration` → passed
- `npx tsx religance/shared/crm/mail-workflow/test_workflow_confirm_card.ts` → ok
- `grep -rn "looksLikeSequence\|sequenceRequested" src/` returns **nothing** — collection is
  phase 4 and must not have leaked in

---

# Phase 3 — Per-step templates

**Goal:** each step can use its own template, and history records which one actually sent.

### Files

| File | Change |
|---|---|
| `src/models/mail-workflow-run.model.ts` | `templateId` |
| `src/services/mail-workflow/recurrence.ts` | `stepTemplateId` |
| `src/services/mail-workflow/scheduler.ts` | stamp on the run; per-step skip rows |
| `src/services/mail-workflow/send-executor.ts` | read the run's template; failure breaker |
| `src/services/mail-workflow/chat-parser.ts` | `missingVariables` union |
| `src/services/mail-workflow/mail-history.ts` | scan limit; template name |

**Do NOT touch:** the card, the frontend, the conversation flow.

### 3.1 Stamp the template on the run

In `mail-workflow-run.model.ts`, add to both the document type and the schema:

```ts
  /**
   * Denormalised at occurrence creation. The workflow's template can be changed or deleted
   * afterwards, and a sequence's steps each carry their own — history has to say what
   * actually went out. Empty for runs written before sequences existed.
   */
  templateId: string;
```

```ts
    templateId: { type: String, default: '' },
```

In `recurrence.ts`, next to `materializeSequence`:

```ts
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
```

In `scheduler.ts`'s `createOccurrenceRun`, add to the `MailWorkflowRunModel.create({...})`
call, next to `providerIdempotencyKey`:

```ts
      templateId: stepTemplateId(modelScheduleToContract(wf.schedule), occurrence) ?? wf.templateId,
```

In `send-executor.ts`, replace:

```ts
  const template = templates.find((t) => t.id === wf.templateId);
```

with:

```ts
  // The run stamped its template when the occurrence was created, so editing or deleting
  // the workflow's template cannot retroactively change what this send used. `||` covers
  // every run written before sequences existed — no backfill.
  const runTemplateId = run.templateId || wf.templateId;
  const template = templates.find((t) => t.id === runTemplateId);
```

and use `runTemplateId` in the `run.template_missing` log payload just below.

### 3.2 Variable union — blocking

`missingVariables` loads exactly one template:

```ts
  if (!draft.templateId) return null;
  const template = await loadTemplate(userId, draft.templateId);
```

A later step's template can require variables the first one does not. They are never
collected, never asked for, and `applyTemplate` does not fail on an unknown placeholder —
`render.ts`'s own self-check pins the behaviour:

```ts
assert.equal(applyTemplate('Hi {{contact_name}}', {}), 'Hi [contact_name]');
```

So a customer receives *"Your quotation [quotation_number] is ready."* Silent,
outward-facing, unrecoverable.

Collect the union:

```ts
/** Every distinct template this draft will send, workflow default first. */
function draftTemplateIds(draft: ConversationDraft): string[] {
  const ids = new Set<string>();
  if (draft.templateId) ids.add(draft.templateId);
  for (const step of draft.schedule?.steps ?? []) {
    if (step.templateId) ids.add(step.templateId);
  }
  return [...ids];
}

async function missingVariables(
  userId: string,
  draft: ConversationDraft,
): Promise<string[] | null> {
  const ids = draftTemplateIds(draft);
  if (!ids.length) return null;
  // The UNION across every step. A per-step template can need a variable the first one does
  // not, and an uncollected placeholder does not fail the send — it mails "[quotation_number]".
  const missing = new Set<string>();
  for (const id of ids) {
    try {
      const template = await loadTemplate(userId, id);
      for (const name of missingExtraVars(template.subject, template.body, draft.variables)) {
        missing.add(name);
      }
    } catch {
      // A template that no longer loads is caught by validateCreateContract before send.
    }
  }
  return missing.size ? [...missing] : null;
}
```

`computeMissingFields` is untouched — the existing `variables` field covers this.

### 3.3 One skip row per skipped step

`recordSkippedOccurrence` writes **one** row for N skipped occurrences using
`plan.lastSkipped`. For a sequence the other N−1 steps leave no trace at all, and history
under-reports without saying so.

Widen the `skip` variant of `CatchUpPlan` in `recurrence.ts`:

```ts
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
```

```ts
const SKIP_DETAIL_LIMIT = 20;
```

Populate it in `planCatchUp`'s walk, then have `scheduler.ts` write one `status: 'skipped'`
run row per entry. The `{workflowId, scheduledAt}` unique index makes each row distinct;
treat a duplicate-key error as already-recorded, exactly as `createOccurrenceRun` does.

### 3.4 Failure circuit breaker

`failureCount` is incremented at `send-executor.ts:528` and **never read** — no threshold, no
auto-pause. One bad configuration on a 20-step sequence produces 20 failed runs and no
escalation.

```ts
const MAX_CONSECUTIVE_FAILURES = 3;
```

**Deliberate semantic change:** `failureCount` becomes *consecutive* failures — reset to `0`
on any successful run, and when it reaches `MAX_CONSECUTIVE_FAILURES` set the workflow to
`paused` and log `workflow.paused_failures`. It is currently cumulative and is exposed
through `MailWorkflow.failureCount` (`workflow.service.ts:281`), so check whether anything
in `religance/` renders it before changing the meaning. If it does, say so and stop rather
than changing it silently.

### 3.5 History

`RUN_SCAN_LIMIT = 500` in `mail-history.ts`: at up to 20 runs per sequence, roughly 25
sequences exhaust the scan and the timeline truncates with no indication. Raise it to 2000
and note the ceiling in a `ponytail:` comment with pagination as the upgrade path.

Surface the per-mail template name now that the run carries `templateId` — that is the
reason the field exists.

### 3.6 Tests

`recurrence.ts`:

31. `stepTemplateId` returns the right step's template for each instant
32. It returns `undefined` for a non-sequence schedule and for an instant not in the list
33. **The counter trap:** build a sequence, skip the first occurrence via `planCatchUp`,
    and assert `stepTemplateId` still resolves step 2 correctly — this is the bug the whole
    design decision exists to prevent, so assert it directly

`chat-parser.ts`:

34. `missingVariables` returns the union across two step templates
35. A variable required only by the last step still appears in the result

`send-executor.ts`:

36. A run with a stamped `templateId` uses it; a run with `''` falls back to `wf.templateId`

`scheduler.ts`:

37. Skipping 3 occurrences writes 3 rows, not 1
38. The breaker pauses after `MAX_CONSECUTIVE_FAILURES` and a success resets the count

### Definition of done — phase 3

All previous checks, plus 31–38. Test 33 is the one that matters — it encodes why
`stepTemplateId` derives from `scheduledAt` rather than `runCount`.

---

# Phase 4 — Conversation collection

**Goal:** a user can describe a sequence in chat.

### Files

`src/services/mail-workflow/chat-parser.ts`, `src/services/mail-workflow/chat-draft.ts`.

**Do NOT touch:** `chat-time.ts`. `parseWhen` stays single-schedule. Do not write a
deterministic sequence parser — the model extracts, `sanitizeSchedule` validates. That
division already exists; keep it.

### 4.1 The gate — ships regardless of the rest

`"every 2 days"` matches none of the current triggers, falls through to `parseWhen`, returns
`null`, and the LLM rounds it to `daily` at midnight. **That is a live bug today**, not a
missing feature. This section ships even if nothing else in phase 4 does.

Same failure class as the literal-phrase `DELIVERY_STATUS_RE` that was already replaced with
a fuzzy verb match: trigger on **structure**, not a phrase list.

```ts
const SEQ_INTERVAL_RE = /\bevery\s+(?:other|second|third|\d{1,3})\s+(?:day|week|month|hour)s?\b/;
const SEQ_COUNT_RE = /\b(?:\d{1,2}|two|three|four|five|twice|thrice)\s+(?:mails?|emails?|times|sends?)\b/;
const SEQ_CHAIN_RE = /\b(?:then|after that|followed by|and then)\b/;
const SEQ_NOUN_RE = /\b(?:sequence|drip|campaign|follow[- ]?ups?)\b/;
const SEQ_ORDINAL_RE = /\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\b/g;
const CLOCK_TOKEN_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/g;

/**
 * True when the message describes MORE THAN ONE send. Matches on structure rather than a
 * phrase list, because a phrase list is what let "every 2 days" fall through to the model
 * and come back as "daily at 12:00 AM".
 */
export function looksLikeSequence(text: string): boolean {
  const t = normalize(text);
  if (SEQ_INTERVAL_RE.test(t) || SEQ_COUNT_RE.test(t) || SEQ_CHAIN_RE.test(t) || SEQ_NOUN_RE.test(t)) {
    return true;
  }
  const ordinals = t.match(SEQ_ORDINAL_RE) ?? [];
  if (ordinals.length >= 2) return true;
  const clocks = t.match(CLOCK_TOKEN_RE) ?? [];
  return clocks.length >= 2;
}
```

Self-check it directly. `"every 2 days"`, `"send it 3 times"`, `"2pm then 5pm"`,
`"first ... second ..."` → `true`. `"send this to rahul now"`, `"every day at 10am"`,
`"tomorrow at 3pm"` → `false`. That last group is the one that matters: a false positive
here drags ordinary single sends into the sequence flow.

### 4.2 Grammar

In `buildSystemPrompt`, immediately after the existing line:

```ts
    'schedule is {frequency:"once", runAt:ISO} or {frequency:"daily"|"weekly"|"monthly", time:"HH:mm", dayOfWeek?:1-7, dayOfMonth?:1-31}.',
```

add:

```ts
    'For MORE THAN ONE send, schedule is {frequency:"sequence", startAt:ISO, sameDay?:boolean, steps:[{spec:{kind:"after",minutes:N,from:"previous"|"start"}}|{spec:{kind:"at",time:"HH:mm",dayOffset:N}}]}. Use it only when the user describes several sends. Set sameDay true if they scoped it to one day ("3 mails today").',
```

### 4.3 Collection

**Zero new `MissingField`s.** For a sequence draft `schedule` stays missing until the steps
validate, so `computeMissingFields` is untouched.

Add one boolean to `ConversationDraft` in `chat-draft.ts`:

```ts
  /**
   * The request described several sends, so the schedule question asks for steps rather
   * than a single time. Genuine state — it comes from the original message, which is not
   * persisted, so it cannot be derived the way missingFields can.
   */
  sequenceRequested?: boolean;
```

Clear it in `resetDraft` / `emptyDraft` alongside the other fields.

Set it in the dispatcher when `looksLikeSequence(text)` and the draft is in the create flow,
**before** the `parseWhen` branch — otherwise `"every 2 days"` is still handed to a parser
that cannot represent it.

One question, not three. In `questionFor`, when `field === 'schedule'` and
`ctx.sequenceRequested`:

> How should the sequence go? Give me the steps — for example: *"an hour from now, then 2pm
> tomorrow, then 2 hours after that."*

Escalation at `count >= 2` appends: *"You can also tell me how many sends and which template
each one uses."*

Templates are not asked about per step by default — every step inherits `draft.templateId`.

### 4.4 Tests

39. `looksLikeSequence` — the true and false groups from 4.1, asserted individually
40. `"every 2 days"` sets `sequenceRequested` and does **not** produce a `daily` schedule
41. The schedule question changes wording when `sequenceRequested` is set
42. **The regression that matters:** a plain single-send request
    (`"send the intro template to rahul tomorrow at 3pm"`) takes exactly the same number of
    turns and produces the same schedule as before phase 4. Assert the schedule value, not
    just that it succeeded

### Definition of done — phase 4

All previous checks, plus 39–42. Test 42 is the gate: if collecting a single send got longer,
the gate is too loose and needs tightening before this phase lands.

---

# Phase 5 — Ambiguity clarification

**Goal:** the bot asks instead of guessing. Last, because it is the most likely to regress
single-send behaviour.

### Files

`src/services/mail-workflow/chat-draft.ts`, `src/services/mail-workflow/chat-parser.ts`.

### 5.1 The rule

> An ambiguous value is **missing**, not answered. Ambiguity is resolved before the card is
> built, never inside it.

The same rule `computeMissingFields` already enforces for recipients, where an unmatched hint
used to satisfy the field and the failure only surfaced three questions later. A step whose
time resolves to two instants is that bug wearing a clock.

### 5.2 No new machinery

The draft carries the **un-materialized** spec, and the question is *derived* from it:

```ts
export type RawStep = {
  spec?: StepSpec;
  /** More than one when the phrasing admits several clocks ("around 7 or 8"). */
  candidates?: string[];
  templateId?: string;
};

export type SequenceSpec = {
  anchor?: 'now' | 'after_gap';
  count?: number;
  sameDay?: boolean;
  steps: RawStep[];
};
```

on `ConversationDraft` as `sequenceSpec?: SequenceSpec`.

```ts
export type Ambiguity =
  | { kind: 'count' }
  | { kind: 'anchor'; gapMinutes: number; count: number }
  | { kind: 'stepTime'; stepIndex: number; candidates: string[] };

/**
 * The outstanding question, derived — exactly as nextMissingField derives from
 * computeMissingFields()[0]. Nothing is stored that could drift out of sync.
 */
export function nextAmbiguity(draft: ConversationDraft): Ambiguity | null;
```

Order: `count` → `anchor` → `stepTime`. Count first because it decides whether this is a
sequence at all, and because knowing it lets the anchor question name real dates instead of
abstractions.

Widen `DraftChoice.field` to `'templateId' | 'recipientId' | 'anchor' | 'stepTime'` and reuse
`pendingChoices`, `applyChoice` and `choiceFieldStillOpen` for every ambiguity. No new
rendering path.

### 5.3 Candidate elimination — before asking anything

```ts
/**
 * Drop candidates that would need a day roll to stay after the previous step. That is what
 * makes "at 7" following a 5 PM send unambiguous — 7 PM is clean, 7 AM is tomorrow — so the
 * bot only asks about things that are genuinely open. It also catches the dangerous case,
 * where a bare hour read as AM silently lands a day late.
 */
export function cleanCandidates(
  candidates: string[],
  previous: Date,
  timezone: string,
): string[];
```

1. Exactly one survives → take it silently.
2. More than one → ask.
3. None → roll the earliest forward and take it.

Dedupe first: a model returning `["19:00", "19:00"]` must not produce a one-item "choice".
Cap at 4; beyond that ask for a specific time rather than rendering a list.

### 5.4 Answer matching — no ordinals on time shortlists

With candidates `2 PM / 3 PM`, `"2"` reads as 2 PM (choice #1) *or* choice #2 (3 PM), and
the two disagree. Value-before-ordinal does not resolve it; it just picks a side.

**Render `stepTime` shortlists without numbers** — *"2 PM or 3 PM?"* — and match by value
only. That removes the collision instead of arbitrating it, and is less code than either
rule. `"the second one"` still works through the existing word-ordinal path.

In the dispatcher, the existing block:

```ts
  if (draft.pendingChoices?.length) {
    const picked = parseChoiceOrdinal(text, draft.pendingChoices.length);
```

must skip when the shortlist's field is `stepTime`, and try value-matching instead.

A non-candidate answer (`"7:30"`) is a **correction**, not a rejection: apply it to that
step, re-materialize, re-validate. It must not be dropped.

### 5.5 Count answers

| Answer | Behaviour |
|---|---|
| `1` | Not a sequence — collapse to `once` |
| `0`, negative, non-numeric | Re-ask with escalation. Never default |
| `> MAX_SEQUENCE_STEPS` | Refuse and name the cap. Never truncate |
| "forever", "ongoing", "indefinitely" | *"I can only run open-ended schedules daily, weekly or monthly — a custom gap like every 2 days needs a number of sends. How many, or shall I make it weekly?"* |
| "a few", "several" | Not a number — re-ask |

The refusal is the point: it is why `interval: N` is not in the data model. Every finite
interval request becomes a sequence; the infinite ones are declined out loud instead of
silently downgraded.

### 5.6 Anchor

A 2-item shortlist carrying **the actual resulting dates**, because "starting today or after
the first gap" is abstract and dates are not:

```
Starting today, or in two days?
  1. Today Aug 21, then Aug 23 and Aug 25
  2. Aug 23, then Aug 25 and Aug 27
```

Where no clock was given, show the `09:00` default in the label so it is visible and
correctable on the card rather than costing a fourth question.

**Guard:** if option 1's first instant is already in the past (asked late at night against a
09:00 default), do not offer a past instant — use the next valid slot and say so.

### 5.7 Deflections

`"you pick"` / `"whatever"` against a `stepTime` shortlist takes the earliest clean candidate
**and says which one it took**. Against `count` it does **not** guess — a made-up number of
outbound emails is not a safe default.

### 5.8 No preview while ambiguous

Enforce at the preview builder, not only at the call site: `handleCreateDraft` must not reach
`buildDraftPreview` while `nextAmbiguity(draft)` is non-null. Assert both.

### 5.9 Tests

43. `"every 2 days"` with no count asks for a count and materializes nothing
44. `"forever"` refuses instead of inventing a number
45. `count: 1` collapses to a `once` schedule
46. `count` over the cap refuses and names it
47. Anchor shortlist labels carry real dates on both branches
48. Anchor option 1 never offers an instant in the past
49. `"at 7"` after a 5 PM step resolves to 7 PM with **no** question
50. `"around 7 or 8"` produces a 2-item shortlist
51. `"8"` against that shortlist selects 8:00 PM
52. `"2"` against a `2 PM / 3 PM` shortlist is unambiguous — no ordinal reading exists
53. `"7:30"` against a shortlist is applied as a correction, not dropped
54. Duplicate candidates are deduped before asking
55. A deflection on `stepTime` picks the earliest and names it; on `count` it re-asks
56. No preview is built while `nextAmbiguity()` is non-null

### Definition of done — phase 5

All previous checks, plus 43–56, plus phase 4's test 42 still green: **single-send collection
must not have gotten longer.** Re-run it explicitly here — phase 5 touches the same
dispatcher.

---

# Rollback

Forward-only. `'sequence'` must stay in the Mongo `frequency` enum **permanently**, even if
the feature is disabled: once a document holds it, removing the value makes that document
unsaveable — it can no longer be paused or cancelled, only deleted.

To disable without a schema change, make `looksLikeSequence` return `false` (phase 4).
Existing sequence workflows keep running to completion; no new ones are created.
