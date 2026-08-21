# Mail Sequences — Spec

Status: proposed, not implemented.

Lets a user schedule an arbitrary series of sends: non-uniform gaps, several mails on the
same day at their own times, a fixed number of sends, and a different template per step.

## 1. Scope

**In**

- A finite, ordered list of sends with arbitrary spacing.
- Per-step timing given either as a **relative offset** ("after 1 hour", "3 days later") or
  an **absolute wall-clock time** ("around 2 in the afternoon"), freely mixed.
- Several steps on the same civil day.
- An optional per-step template; steps without one inherit the workflow's.
- The step count is the stop condition. No `maxRuns`.

**Out — deliberately**

| Not doing | Why |
|---|---|
| `interval: N` on `daily`/`weekly` | Asking "how many sends?" turns every interval request into a finite sequence, which the step list already holds. See §15.2 — the clarifier is what makes the data model sufficient. |
| A recurring sequence ("this 3-step drip every Monday") | Two schedule kinds composed. No demand yet. |
| Offsets relative to **actual** send time ("2h after it really goes out") | Makes the schedule non-materializable — see §4. Anchored to *scheduled* time instead. |
| Editing a live sequence | Pause → cancel → recreate covers it. See §10. |
| Per-step recipients | Sequence targets the workflow's recipient set, whole. |
| Conditional steps ("only if no reply") | Needs reply detection. Separate feature. |

## 2. Timing model

A step's timing is one of two specs:

```ts
type StepSpec =
  /** Relative. "after 1 hour", "3 days later". */
  | { kind: 'after'; minutes: number; from: 'start' | 'previous' }
  /** Absolute wall clock in the workflow timezone. "at 2pm", "9am on day 3". */
  | { kind: 'at'; time: string /* HH:mm */; dayOffset: number };
```

`from: 'previous'` is the default and what conversational phrasing almost always means
("then 2 hours later"). `from: 'start'` exists for "day 7 after signup" phrasing.

`dayOffset` counts civil days from `startAt`'s date **in the workflow timezone**, so
`dayOffset: 0` is "today".

The user's own example maps to:

| Step | Said | Spec |
|---|---|---|
| 1 | "first after 1 hour" | `{kind:'after', minutes:60, from:'previous'}` |
| 2 | "then around 2 in the afternoon" | `{kind:'at', time:'14:00', dayOffset:0}` |
| 3 | "then after 2 hours" | `{kind:'after', minutes:120, from:'previous'}` |

Two mails on one day is just two `at` steps sharing a `dayOffset`.

## 3. Data model

### Contract (`src/services/mail-workflow/contract.ts`)

```ts
export type Frequency = 'once' | 'daily' | 'weekly' | 'monthly' | 'sequence';

export type SequenceStep = {
  spec: StepSpec;
  /** Materialized ISO-8601 UTC instant. The engine reads only this. */
  at: string;
  /** Absent = inherit the workflow's templateId. */
  templateId?: string;
};

export type WorkflowSchedule = {
  frequency: Frequency;
  // ...existing fields unchanged...
  /** sequence only: the anchor. Frozen at preview. Never moves. */
  startAt?: string;
  /** sequence only: ordered, materialized, strictly increasing `at`. */
  steps?: SequenceStep[];
};
```

`frequency: 'sequence'` rather than a parallel `kind` discriminator: one union, one Mongo
enum, and the 13 existing `frequency === 'once'` call sites keep answering correctly
(a sequence is not a single send).

### Mongo

`mail-workflow.model.ts:43` — add `'sequence'` to the enum. Add `startAt: Date` and a
`steps` subdoc array to `scheduleSchema`. Both optional; existing documents are untouched
and no migration runs.

`mail-workflow-run.model.ts` — add `templateId: { type: String, default: '' }`.

`workflow.service.ts:244` `modelScheduleToContract` — pass `startAt`/`steps` through.

## 4. Materialization

**Decision: materialize once, at preview build, and freeze.**

The card is the contract. What the user approves is a list of real dates and times, and
confirming does not shift them. This also keeps the engine trivial — the runtime never
re-derives an offset, it reads a list.

The cost: if the card sits unconfirmed for an hour, "after 1 hour" has already elapsed.
That is handled the same way a stale one-time card is (§9), not by re-materializing.

```
materialize(startAt, timezone, specs) -> Date[]
  prev = startAt
  for spec in specs:
    if spec.kind == 'after':
      base = (spec.from == 'start') ? startAt : prev
      t = base + spec.minutes minutes
    else:
      civil = civilDateInZone(startAt, timezone) + spec.dayOffset days
      t = utcFromZoned(timezone, civil, spec.time)
      # ponytail: roll whole days until strictly after prev. "2pm" said after a 3pm send
      # obviously means tomorrow; rejecting it would be pedantic. Bounded at 366.
      while t <= prev and rolls < 366: civil += 1 day; t = utcFromZoned(timezone, civil, spec.time)
    reject unless t > prev
    emit t; prev = t
```

Recomputing `utcFromZoned` from civil parts on every roll is what keeps DST correct —
the same primitive the existing engine already uses and tests (`recurrence.ts:208–224`).
A civil time that does not exist on a spring-forward day resolves however `utcFromZoned`
resolves it today; sequences inherit that behaviour rather than inventing a second rule.

`startAt` = the instant the preview is built.

## 5. Validation

In `sanitizeSchedule` (`chat-parser.ts:446`), which already exists to stop the model
inventing schedules. A sequence that fails any rule is rejected whole — never trimmed,
never repaired.

| Rule | Bound |
|---|---|
| Step count | 2 ≤ n ≤ `MAX_SEQUENCE_STEPS` (20) |
| `after.minutes` | 1 ≤ m ≤ 525600 (1 year) |
| `at.time` | `/^\d{2}:\d{2}$/`, valid clock |
| `at.dayOffset` | 0 ≤ d ≤ 365 |
| Materialized instants | **strictly increasing** |
| Gap between steps | ≥ `MIN_STEP_GAP_MINUTES` (5) |
| Total span | ≤ 365 days from `startAt` |
| `templateId` | must resolve against the user's templates, or be absent |
| `endDate`, `maxRuns` | stripped — the list length is the bound |

**UX vs provider limits:** `RUN_SCAN_LIMIT = 2000` (`mail-history.ts`) is a structure/UX
guardrail for run-history scans — not a Microsoft Graph or Exchange send ceiling.
`MAX_SEQUENCE_STEPS = 20` caps what one sequence can plan. **Delivery is governed by
Exchange/Graph throttling and tenant policy**, not by these UX caps.

`MIN_STEP_GAP_MINUTES = 5` because the scheduler ticks every 30s (`src/index.ts:66`) and
runs at most one occurrence per workflow per tick. Sub-minute gaps would technically work
but arrive visibly late, which reads as a bug.

The strictly-increasing rule is the one that matters: "at 2pm, then 1 hour later, then at
9am" must be refused, not silently reordered.

## 6. Engine

`computeNextRunAt` (`recurrence.ts:93`) gains one branch, ahead of the `once` check:

```ts
if (schedule.frequency === 'sequence') {
  const next = (schedule.steps ?? [])
    .map((s) => new Date(s.at))
    .find((d) => d > after);
  return next ?? null;
}
```

That is the whole engine change. Everything downstream already speaks only this function:

| Component | Change |
|---|---|
| `planCatchUp` (`recurrence.ts:160`) | **none** — calls `computeNextRunAt` only |
| `processDueWorkflow` (`scheduler.ts:146`) | **none** |
| `claimWorkflow`, leases, `releaseWorkflow` | **none** |
| Run idempotency | **none** — `{workflowId, scheduledAt}` unique index and `providerIdempotencyKey` (`retry.ts:3`) both key on the instant, so distinct steps are distinct for free |
| `exhaustedByLimits` (`scheduler.ts:140`) | **none** — a sequence ends by returning `null` |
| `dayMatchesSchedule` | **none** |

Stale-step policy is inherited unchanged: a step missed by more than
`MAX_MISSED_RUN_AGE_MS` (2h) is skipped, and at most the most recent due step runs.
A skipped step does **not** shift later steps — they fire on their frozen instants.

## 7. Per-step templates

### The bug this avoids

`runCount` cannot be used as a step index. `recordSkippedOccurrence` (`scheduler.ts:70`)
writes a run row but never increments `runCount` — that happens only on execution
(`send-executor.ts:526`). Worse, N consecutive missed occurrences produce **one** row.
After an outage both the counter and the row count undercount, so "which template does
step 3 use" would silently answer step 2's.

### The rule

**Derive the step from `scheduledAt`, never from a counter.** Same key the run
idempotency already uses.

```ts
export function stepTemplateId(schedule: WorkflowSchedule, scheduledAt: Date): string | undefined {
  const iso = scheduledAt.toISOString();
  return schedule.steps?.find((s) => s.at === iso)?.templateId;
}
```

Exact string match is safe: the run is created with the instant `computeNextRunAt`
returned, which is the instant in the list.

### Where it is resolved

Once, in `createOccurrenceRun` (`scheduler.ts`), stamped onto the run:

```ts
templateId: stepTemplateId(schedule, occurrence) ?? wf.templateId
```

`send-executor.ts:425` then reads `run.templateId || wf.templateId`. The `||` covers every
run written before this change — no backfill.

This is the same denormalize-at-send-time call already made for `contactName`,
`companyName` and `subject` on the run recipient, for the same reason: history must stay
readable after the template is rewritten. It also fixes an existing gap — the mail-history
timeline currently cannot say which template a given mail used.

`workflow.templateId` stays `required: true` and means "the default". Steps override it.

## 8. Conversation flow

**No new `MissingField`.** `computeMissingFields` (`chat-draft.ts:85`) is unchanged: for a
sequence draft, `schedule` stays missing until `steps[]` validates. The escalating-question
machinery works as-is.

**Gate on the user's own words.** Asking every user "how many times?" and "which template
each time?" turns "send this to Rahul now" into a six-question interrogation — a
regression on the most common request. Sequence collection activates only on an explicit
signal — see §15.1 for the trigger set, which must match on *structure* (a count of mails,
ordinals, an interval, two or more times in one message) rather than a phrase list.

Otherwise one template, one schedule, exactly as today.

**One question, not three.** When the signal fires and the schedule is missing:

> How should the sequence go? Give me the steps — for example: *"an hour from now, then 2pm
> tomorrow, then 2 hours after that."*

Escalation at count ≥ 2 adds: *"You can also say how many sends and which template each one
uses."*

**Parsing.** The LLM extracts `steps[]` into the shape in §2; §5 validates it hard. No new
deterministic parser — `parseWhen` stays single-schedule and untouched. This is the same
division of labour the code already uses: model extracts, `sanitizeSchedule` decides.
Grammar at `chat-parser.ts:371` gains the `sequence` form.

**Templates.** Not asked by default — every step inherits. Only if the user mentions
differing templates does the flow resolve one per step, reusing the existing
`pendingChoices` shortlist per ambiguous step.

## 9. Confirm card

`scheduleLabel` (`workflow.service.ts:65`) returns one string; a sequence needs a table.
`PreviewSummary` gains `steps: { index, at, templateName, passed }[]`.

`WorkflowConfirmCard` replaces the "Schedule" / "First send" rows with:

```
Sequence — 3 sends
  1.  Today, 11:00 AM      First Introduction
  2.  Today,  2:00 PM      First Introduction
  3.  Today,  4:00 PM      Follow-up 1
```

Header stays "Confirm recurring email"; the button stays "Confirm & Schedule".

**Stale card.** The existing `sendTimeHasPassed` + one-shot `setTimeout`
(`WorkflowConfirmCard.tsx:40,77`) generalizes: the timer targets the **next unpassed
step**, and a passed step renders `Immediately — 11:00 AM has passed`. Same semantics as a
past one-time card: confirming sends it now.

If **every** step has passed, disable Confirm and say so — an all-stale sequence would
otherwise fire the whole list at once.

## 10. Lifecycle

- `startAt` is immutable. Steps are immutable.
- Pause / resume / cancel work unchanged — they act on the workflow, not the schedule.
- Resuming after a long pause: already-past steps are stale-skipped by `planCatchUp`. No
  burst. Later steps keep their frozen instants.
- **Editing a live sequence is out of scope.** Inserting a step would shift every later
  `scheduledAt`, silently re-mapping steps under runs already created against the old
  instants. Cancel and recreate until there is real demand.
- The workflow completes when `computeNextRunAt` returns `null` — existing path,
  `scheduler.ts:171`.

## 11. Touch points

| File | Change | Size |
|---|---|---|
| `contract.ts` | `Frequency`, `StepSpec`, `SequenceStep`, `startAt`/`steps` | S |
| `recurrence.ts` | one branch in `computeNextRunAt`; `materializeSequence`; `stepTemplateId` | M |
| `chat-parser.ts:371` | grammar for the sequence form | S |
| `chat-parser.ts:446` | `sanitizeSchedule` — all of §5 | **L** |
| `chat-parser.ts` | sequence-signal gate + the one question | M |
| `scheduler.ts` | stamp `templateId` in `createOccurrenceRun` | S |
| `send-executor.ts:425` | `run.templateId \|\| wf.templateId` | S |
| `mail-workflow.model.ts` | enum + `startAt` + `steps` subdoc | S |
| `mail-workflow-run.model.ts` | `templateId` | S |
| `workflow.service.ts` | `modelScheduleToContract`, `scheduleLabel`, preview `steps[]` | M |
| `mail-history.ts` | surface per-mail template name | S |
| `types.ts` (FE) | mirror the contract | S |
| `WorkflowConfirmCard.tsx` | step table, per-step stale marker | **L** |

Validation and the card are the work. The engine is one branch.

## 12. Tests

Backend, `assert`-based, in the existing `check:mail` self-check convention.

`recurrence.ts`

1. Materialize the user's example (`after 60m`, `at 14:00 d0`, `after 120m`) from a fixed
   `startAt` → three exact instants.
2. `at` earlier than the previous step rolls forward one day.
3. Two `at` steps on one `dayOffset` → two distinct same-day instants, ordered.
4. `computeNextRunAt` walks the list and returns `null` past the last step.
5. `planCatchUp` on a mid-sequence outage skips stale steps, runs at most the freshest, and
   leaves later steps on their frozen instants.
6. A sequence spanning a DST transition keeps each `at` step at its stated wall-clock time.

`chat-parser.ts`

7. Non-increasing instants rejected whole.
8. Gap below `MIN_STEP_GAP_MINUTES` rejected.
9. Step count over `MAX_SEQUENCE_STEPS` rejected.
10. `endDate` / `maxRuns` stripped from a sequence.
11. `templateId` naming a template the user does not own → rejected, not silently dropped.

`scheduler.ts`

12. `stepTemplateId` picks the right step **after** a skipped occurrence — the `runCount`
    trap in §7, asserted directly.
13. Step with no `templateId` falls back to the workflow's.

Frontend, `test_workflow_confirm_card.ts`

14. Card marks passed steps and targets its timer at the first unpassed one.
15. All steps passed → Confirm disabled.

## 13. Phasing

1. **Engine + model.** §3, §4, §6, tests 1–6. Nothing user-visible; sequences constructible
   only in tests.
2. **Validation + card.** §5, §9, tests 7–11, 14–15. Sequences creatable via the card.
3. **Per-step templates.** §7, tests 12–13.
4. **Conversation.** §8. Last, because it is the only part that can regress the existing
   single-send flow.

Each phase ships green on `npm run check:mail` and `npm run check:mail:integration`.

## 14. Open question

`startAt` is the preview instant, so "after 1 hour" means an hour after the card was
*shown*, not after it was *confirmed*. That is what makes the card honest, but if users
routinely leave cards sitting, step 1 will often be already-passed on confirm and fire
immediately. Alternative is re-materializing at confirm, which makes the card an estimate.

Recommend shipping frozen and revisiting only if it actually bites.

---

# 15. Ambiguity clarification

§8 as first written was a *collection* layer — it asks for a missing field. It has no way
to say "you gave me an answer, but it resolves to more than one thing." Two of the worked
examples below break on exactly that, so this section is load-bearing, not polish.

## 15.0 The rule

> **An ambiguous value is missing, not answered. Ambiguity is resolved before the card is
> built — never inside it.**

This is the same rule `computeMissingFields` already enforces for recipients: an unmatched
hint like `"xyzabc"` used to satisfy the field, and the failure only surfaced three
questions later. A step whose time resolves to two instants is the identical bug wearing a
clock. A preview is only ever built from a fully determined sequence.

**No new state.** The draft carries the *un-materialized* spec:

```ts
draft.sequenceSpec?: {
  anchor?: 'now' | 'after_gap';
  count?: number;
  steps: RawStep[];        // a RawStep may carry `candidates: string[]` instead of `time`
}
```

and `nextAmbiguity(draft)` derives the outstanding question from it, exactly as
`nextMissingField` derives from `computeMissingFields()[0]`. Nothing is stored that could
drift. (The spec itself is genuine state — it is the model's raw extraction, not a copy of
something computed.)

**No new machinery.** `pendingChoices` + `parseChoiceOrdinal` + `applyChoice` already render
"I found more than one match — reply with the name or the number." Widen
`DraftChoice.field` to `'templateId' | 'recipientId' | 'anchor' | 'stepTime'` and every
ambiguity reuses that path, `choiceFieldStillOpen` included.

## 15.1 The gate must fire on structure

`"every 2 days"` matches **none** of the phrase triggers §8 originally listed, so it never
reaches the sequence path at all — it falls through to `parseWhen`, returns `null`, and the
LLM silently rounds it to `daily`. That is the exact bug from the audit, unfixed.

Same failure class as the literal-phrase `DELIVERY_STATUS_RE` already replaced with a fuzzy
verb match. Trigger on structure:

| Trigger | Example |
|---|---|
| interval language | `every 2 days`, `every other week`, `every 3rd day` |
| an explicit count of sends | `3 mails`, `send it 4 times`, `twice` |
| two or more ordinals | `first … second … third` |
| chaining words | `then`, `after that`, `followed by` |
| two or more times in one message | `at 2pm … at 7` |
| explicit nouns | `sequence`, `drip`, `follow up`, `campaign` |

Interval language is the important addition: today it is routed to the recurrence path,
where the interval is *guaranteed* to be discarded.

## 15.2 Three ambiguity kinds

Asked in this order, one at a time, at most one per turn.

### `count` — asked first

Fires when the request is interval-shaped with no stated number of sends.

> **How many times should it go out?**

Count comes first because it decides whether this is a sequence at all, and because knowing
it lets the *anchor* question name real dates instead of abstractions.

If the user says *forever* / *ongoing* / *indefinitely*, answer honestly rather than
inventing a number:

> I can only run open-ended schedules daily, weekly or monthly — a custom gap like every
> 2 days needs a number of sends. How many, or shall I make it weekly?

This is the whole reason `interval: N` is not in the data model: the clarifier converts
every finite interval request into a sequence, and refuses the infinite ones out loud
instead of silently downgrading them.

### `anchor` — asked second

Fires when the first step's timing is relative and the start is unstated. Rendered as a
2-item shortlist carrying **the actual resulting dates**, because "starting today or after
the first gap" is abstract and the dates are not:

```
Starting today, or in two days?
  1. Today Aug 21, then Aug 23 and Aug 25
  2. Aug 23, then Aug 25 and Aug 27
```

Where no clock was given, the label shows the `09:00` default so it is visible and
correctable on the card, instead of costing a fourth question.

### `stepTime` — asked last, per step

The model returns `candidates: string[]` on a step instead of `time` when the phrasing
admits more than one clock. Deterministic resolution runs before anything is asked:

1. Drop candidates that would need a **day roll** (§4) to stay after the previous step.
2. Exactly one survives → take it silently.
3. More than one survives → ask.
4. None survive → roll the earliest forward and take it.

Rule 1 is what stops the bot asking about things that are not actually ambiguous. `"at 7"`
after a 5 PM step: 7 PM is clean, 7 AM needs a roll to tomorrow → 7 PM, no question. The
same rule catches the dangerous case, where a bare hour would otherwise be read as AM and
silently land a day late.

`"around 7 or 8"` gives two clean candidates → ask:

```
Last one — 7 or 8?
  1. 7:00 PM
  2. 8:00 PM
```

**Answer matching.** `"8"` must select 8 PM, not choice #8. `parseChoiceOrdinal("8", 2)`
correctly returns `null` (out of range), but nothing currently maps it onward. So a
`stepTime` shortlist matches its answer **by value before ordinal**: choice ids are the
`HH:mm` values, and a bare hour matching a candidate wins. `"the second one"` still routes
through the ordinal parser.

`around` is dropped, not modelled. There is no fuzz in the schedule; the chosen instant is
exact and the card shows it.

## 15.3 Worked example — `"every 2 days"`

Today this produces `Every day at 12:00 AM` with no question asked. With §15:

```
U: create a scheduler for prakhar
A: When would you like me to send it?
U: every 2 days
                          gate fires on interval language (§15.1)
A: How many times should it go out?
U: 3
                          count=3, anchor unstated → ask with real dates
A: Starting today, or in two days?
     1. Today Aug 21, then Aug 23 and Aug 25
     2. Aug 23, then Aug 25 and Aug 27
U: 1
                          determined; no clock given → 09:00, shown on the card
A: Which email template should I use?
U: 2
A: [card] Sequence — 3 sends
     1. Aug 21, 9:00 AM   Salt-specific Outreach
     2. Aug 23, 9:00 AM   Salt-specific Outreach
     3. Aug 25, 9:00 AM   Salt-specific Outreach
```

Two questions, both of which the old flow answered by guessing.

## 15.4 Worked example — three mails in one day

> *"send today 3 mails to prakhar, one at 2 in the afternoon, second 3 hours after that,
> and third at around 7 or 8"*

| Element | Resolution | Question? |
|---|---|---|
| gate | `3 mails` + `second`/`third` + two clock times | — |
| recipient | `prakhar` → existing CRM resolution | only if ambiguous |
| count | `3`, stated | **no** |
| step 1 | `at 2 in the afternoon` → `{at, 14:00, d0}` | **no** |
| step 2 | `3 hours after that` → `{after, 180, previous}` → 5:00 PM | **no** |
| step 3 | `around 7 or 8` → candidates `19:00`, `20:00`, both clean | **yes** |
| templates | none mentioned → all inherit | **no** |

```
A: Last one — 7 or 8?
     1. 7:00 PM
     2. 8:00 PM
U: 8
A: [card] Sequence — 3 sends
     1. Today,  2:00 PM   First Introduction
     2. Today,  5:00 PM   First Introduction
     3. Today,  8:00 PM   First Introduction
```

One question, for the one thing the user genuinely left open. Everything else was already
determined, and asking about it would be noise.

Note what has to pass validation for this to work at all: three steps on one `dayOffset`,
gaps of 180 and 180 minutes (≥ `MIN_STEP_GAP_MINUTES`), strictly increasing. All hold.

**Not building:** a volume guardrail. Three mails to one person in six hours is
spam-adjacent, but the card states it plainly and the user asked for it. Add a soft warning
only if it turns out to be a foot-gun in practice.

## 15.5 Interaction with existing behaviour

- **A clarification is not an edit.** During `awaiting_confirmation` the existing question
  branch already preserves the card for questions, help and deflections. Clarifications
  only ever occur in `collecting_create`, before a card exists, so the two never meet.
- **Deflections.** `"you pick"` / `"whatever"` against a `stepTime` shortlist takes the
  earliest clean candidate and says which one it took. Against `count` it does **not**
  guess — a made-up number of outbound emails is not a safe default.
- **Escalation.** `noteAsked` / `askedCount` wording applies unchanged; a re-asked
  clarification restates the options rather than repeating the sentence.
- **Zero new `MissingField`s.** `schedule` simply stays missing while `nextAmbiguity()`
  returns non-null, so `computeMissingFields` is untouched.

## 15.6 Additional tests

16. `"every 2 days"` fires the gate — the regression that started this.
17. `"every 2 days"` with no count asks for a count, and never materializes a schedule.
18. `forever` in answer to the count question refuses instead of inventing a number.
19. The anchor shortlist labels carry real dates on both branches.
20. `"at 7"` after a 5 PM step resolves to 7 PM with no question (roll-elimination).
21. `"around 7 or 8"` produces a 2-item shortlist.
22. `"8"` against that shortlist selects 8:00 PM, not an out-of-range ordinal.
23. Three same-day steps at 14:00 / 17:00 / 20:00 validate and materialize in order.
24. No preview is ever built while `nextAmbiguity()` is non-null.

Test 24 enforces §15.0 and belongs at the preview builder, not only at the call site.

## 15.7 Phasing

§15 becomes **phase 5**, after §8. It depends on the sequence collection flow existing, and
it is the piece most likely to regress single-send behaviour, so it lands last and behind
tests 16–24.

Exception: **§15.1's gate fix ships in phase 4 regardless.** Without it `"every 2 days"`
still silently becomes `daily`, which is a live bug today rather than a missing feature.

---

# 16. Edge cases and worst-case scenarios

Audit of the spec above, before implementation. Severity: **S1** blocks the phase it sits
in, **S2** must ship with the phase, **S3** note it and move on.

Four findings are pre-existing bugs that sequences merely make *reachable*. They are marked
**[live]** — they are not caused by this feature, but this feature detonates them.

## 16.1 S1 — Catch-up fires a burst **[live]** — FIXED (phase 0)

`planCatchUp` (`recurrence.ts:160`) documents its own policy as:

> Policy: skip every occurrence older than `maxAgeMs`, then run **at most the single most
> recent due occurrence**.

It does not do that. It returns `{action:'run'}` on the **first** occurrence that is fresh,
and the scheduler then advances `nextRunAt` to the next one — which is also due and also
fresh, so the following tick runs it too.

Proven with the real function (freshness widened to 3 days so three daily occurrences fall
inside it — the same shape a sequence with sub-2h gaps has under the real 2h window):

```
tick 0: nextRunAt=2026-08-22T04:30Z -> run @ 2026-08-22T04:30Z
tick 1: nextRunAt=2026-08-23T04:30Z -> run @ 2026-08-23T04:30Z
tick 2: nextRunAt=2026-08-24T04:30Z -> run @ 2026-08-24T04:30Z
SENDS FIRED IN 3 CONSECUTIVE TICKS = 3
```

Today this is unreachable: `daily`/`weekly`/`monthly` occurrences are ≥24h apart and the
freshness window is 2h, so **only one** can ever be due-and-fresh. The policy holds by
accident of gap size, not by construction.

A sequence breaks that accident. `MIN_STEP_GAP_MINUTES = 5` against a 2h window means up to
24 steps can be due-and-fresh simultaneously — capped by `MAX_SEQUENCE_STEPS` at 20.

**Worst case:** a 2-hour outage on a 20-step, 50-recipient sequence sends **1000 emails in
10 minutes**, all backlogged, at 30s intervals. Mailbox-reputation event, not a bug report.

**Fix (phase 1, before any sequence can be created):** on the fresh path, walk forward to
the **last** due occurrence, recording the earlier ones as skipped, and run only that one.
This is what the docstring already promises, so it is a correctness fix to existing code,
not new policy. Regression-test it with a `daily` schedule and a widened `maxAgeMs`, which
is how the burst was proven above — that test would have caught this without sequences
existing.

## 16.2 S1 — Per-step templates ship `[placeholder]` to real customers

`missingVariables` (`chat-parser.ts:827`) reads `draft.templateId` and nothing else:

```ts
if (!draft.templateId) return null;
const template = await loadTemplate(userId, draft.templateId);
```

With per-step templates (§7), step 3's template can require variables that step 1's did
not. They are never collected, never asked for, and never reach the card.

At send time `applyTemplate` does not fail on an unknown placeholder — it renders it. From
`render.ts`'s own self-check:

```ts
assert.equal(applyTemplate('Hi {{contact_name}}', {}), 'Hi [contact_name]');
```

**Worst case:** a customer receives an email reading *"Your quotation [quotation_number] is
ready"*. Silent, unrecoverable, and outward-facing.

**Fix (phase 3, blocking):** collect the **union** of required variables across every
distinct template in the sequence before the preview is built. `missingVariables` takes the
step template set, not one id. The existing `variables` `MissingField` then covers it with
no new state.

Consider separately whether `applyTemplate` should keep rendering `[key]` at all for
workflow sends — an unfilled placeholder in an outbound email is arguably a hard failure.
Out of scope here, worth its own decision.

## 16.3 S1 — Silent step loss between preview and confirm

`firstRunAt` (`workflow.service.ts:212`) resolves a sequence to `computeNextRunAt(now)` —
the first step **strictly after now**. Every step already in the past is silently dropped.

Combined with §4's frozen materialization and §14's open question:

- Card built 10:00, steps at 11:00 / 14:00 / 17:00.
- User confirms at 11:30.
- Step 1 is gone. The card promised 3 sends; 2 happen. Nothing says so.

The all-past case is already handled — `firstRunAt` returns `null` and the existing
`SCHEDULE_INVALID` guard fires *"That send time has already passed."* (its wording needs to
fit a sequence). The **partial**-past case is the dangerous one because it succeeds.

**Fix (phase 2, blocking):** re-check at confirm. If any step is in the past, do not
proceed — return what would be dropped and require an explicit re-confirm:

> Two of those times have already passed (11:00 AM, 2:00 PM). I can send the remaining one
> at 5:00 PM, or you can give me new times.

This also resolves §14: freezing stays, and the failure mode it creates becomes visible
rather than silent.

## 16.4 S2 — DST spring-forward resolves to the wrong instant **[live]** — FIXED (phase 0)

`utcFromZoned` (`recurrence.ts:25`) binary-searches for a UTC instant whose zoned parts
match. When the wall-clock time does not exist (spring-forward gap) it falls back to:

```ts
return new Date(Date.UTC(y, mo - 1, d, h, mi));
```

The comment claims this "lands on the instant immediately after the gap". It does not — it
is the raw UTC interpretation. For `America/New_York` on 2026-03-08, a nonexistent 02:30
resolves to `2026-03-08T02:30Z`, which is **21:30 on March 7 local** — roughly five hours
*earlier* than intended, on the previous day.

Invisible today because `Asia/Kolkata` has no DST and recurring schedules rarely name 2 AM.
`at` steps make named wall-clock times the common case.

For a sequence the damage is partly self-limiting: an instant that jumps backwards violates
the strictly-increasing rule (§5) and the whole sequence is rejected. A rare wrong-time send
becomes a rare unexplained refusal. Both are bad.

**Fix (phase 1):** on gap fallback, return the first instant **after** the gap by probing
forward, and add a DST self-check for a real gap timezone.

## 16.5 S2 — `today` must not silently become tomorrow

§4's roll-forward is correct for `"2pm"` said after a 3pm send. It is wrong when the user
explicitly said **today**: rolling turns *"send 3 mails today"* into two today and one
tomorrow, with no mention.

**Fix (phase 2):** carry a `sameDay` flag when the request scoped itself to a day. A step
that would roll past that day is an error, surfaced as a clarification, not a shift:

> 9:00 AM is before the 2:00 PM send, and you said today. Did you mean 9 PM?

## 16.6 S2 — Skipped steps leave no trace

`recordSkippedOccurrence` (`scheduler.ts:70`) writes **one** run row for N skipped
occurrences, using `plan.lastSkipped` as `scheduledAt`. For a sequence the other N−1 steps
have no record at all: history shows a 3-send sequence with 2 rows and no explanation.

**Fix (phase 3):** write one `skipped` row per skipped step. The `{workflowId, scheduledAt}`
unique index makes this natural, and with `templateId` stamped (§7) each row can say which
step it was.

## 16.7 S2 — Answer-matching collision on a time shortlist

§15.2 specifies value-before-ordinal so `"8"` selects 8 PM rather than choice #8. That is
correct for candidates `7 PM / 8 PM`, but breaks for candidates **`2 PM / 3 PM`**:

- value reading: `"2"` → 2 PM → choice #1
- ordinal reading: `"2"` → choice #2 → 3 PM

Both readings are plausible and they disagree.

**Fix:** do not offer ordinals on `stepTime` shortlists at all. Render as *"2 PM or 3 PM?"*
and match by value only. Removes the collision instead of arbitrating it, and is less code
than either rule. `"the second one"` still works via the existing word-ordinal path.

## 16.8 S2 — No failure circuit breaker **[live]**

`failureCount` is incremented (`send-executor.ts:528`) and **never read** — no threshold, no
auto-pause. A systematically broken sequence (deleted template, revoked mailbox, bad
recipient set) produces one failed run per step with no escalation.

Pre-existing, but a 20-step sequence multiplies the noise by 20 and turns a single bad
configuration into 20 failure rows.

**Fix (phase 3):** pause a workflow after N consecutive fully-failed runs. Small, and it
caps every runaway in this list, not just sequences.

## 16.9 S3 — Remaining edge cases

### Materialization

| # | Case | Handling |
|---|---|---|
| a | Two steps materialize to the same instant (`after 60 from start` twice) | Caught by strictly-increasing |
| b | `at 00:00, dayOffset 0` | Always past → rolls to tomorrow. Anchor label must show the **rolled** date, or "today" misleads |
| c | Fall-back DST (2:30 AM occurs twice) | Binary search takes the earlier instant. Deterministic; document it |
| d | First step "now" | `after.minutes >= 1` makes a true zero-delay first step impossible. Allow `0` for step 1, or map "now" to an `at` of the current clock |
| e | Total span | Must be validated on the **materialized** list, not the specs — 20 × `525600` minutes is 20 years otherwise |
| f | Leap day / month end | `dayOffset` is day-based; no Feb-30 class of bug |
| g | Workspace timezone changed after creation | Frozen instants do not move (correct); only the *displayed* wall clock changes |

### Clarification (§15)

| # | Case | Handling |
|---|---|---|
| h | `count = 1` | Not a sequence — collapse to `once` |
| i | `count` 0, negative, non-numeric | Re-ask with escalation. Never default |
| j | `count > MAX_SEQUENCE_STEPS` | Refuse and name the cap. Never truncate |
| k | "a few", "several" | Not a number — re-ask |
| l | Non-candidate answer to a time shortlist ("7:30") | Treat as a correction: re-materialize and re-validate. Must not be dropped |
| m | "both" / "all" to "7 or 8" | One step cannot be two times — re-ask, or offer to add a step |
| n | Duplicate candidates ("7 or 7") | Dedupe before asking, or a 1-item "choice" is rendered |
| o | 5+ candidates from the model | Cap; ask for a specific time instead of a long list |
| p | Mid-clarification change of mind ("actually make it weekly") | Must exit the sequence path cleanly, not apply the answer to a stale spec |
| q | Clarification while a recipient shortlist is open | Field order prevents it (recipients resolve first) — assert it rather than assume it |

### Volume

| # | Case | Handling |
|---|---|---|
| r | 20 steps × 50 recipients = 1000 sends per workflow | Graph throttles (~30/min). No rate limiting beyond the per-tick loop. 16.1's fix removes the burst but not the total |
| s | Several sequences targeting the same lead | Nothing dedupes across workflows |
| t | No per-recipient frequency cap | §15.4 declined a guardrail at 3 steps. Reconsider at 20 |

### History and rollout

| # | Case | Handling |
|---|---|---|
| u | `RUN_SCAN_LIMIT = 500` in `mail-history.ts` | 20 runs per sequence → ~25 sequences exhausts the scan and the timeline silently truncates. Raise it or paginate |
| v | Runs predating this change have no `templateId` | `run.templateId \|\| wf.templateId` covers them; no backfill |
| w | Template deleted mid-sequence | Step fails `TEMPLATE_MISSING`; `finalizeWorkflowAfterRun` does not complete the workflow because `nextRunAt` is already set, so later steps still run. Correct — but nobody is told |
| x | Rollback after a sequence exists | `frequency: 'sequence'` would fail the Mongo enum on any later save, making the workflow unsaveable. Deploy forward-only, and leave the enum value in place permanently even if the feature is disabled |

## 16.10 Revised phasing

| Phase | Adds | Gate |
|---|---|---|
| 0 **(new)** | 16.1 burst fix, 16.4 DST fallback | **DONE** — both fixed in `recurrence.ts`, regression tests in its self-check block. `check:mail` 10/10, integration 7/7 |
| 1 | Engine + model (§3, §4, §6) | 16.9 a–g |
| 2 | Validation + card (§5, §9) | 16.3 confirm re-check, 16.5 `today` |
| 3 | Per-step templates (§7) | **16.2 variable union**, 16.6 skip rows, 16.8 breaker |
| 4 | Conversation (§8) + §15.1 gate | Gate ships here regardless — `"every 2 days"` is broken today |
| 5 | Clarification (§15) | 16.7, 16.9 h–q |

Phase 0 is the change from the original plan: two of the three S1 findings are defects in
code that already ships, and both are testable today. Fixing them first means the sequence
work lands on a floor that holds.

---

# 17. Phase 1 plan — engine and model

**Six phases total (0–5). Phase 0 is done; five remain.**

| Phase | Scope | Status |
|---|---|---|
| 0 | `planCatchUp` burst fix, `utcFromZoned` DST fallback | **done** |
| **1** | **Types, Mongo, materialization, `computeNextRunAt`** | **this plan** |
| 2 | Validation (§5) + confirm card (§9) + confirm re-check (16.3) | |
| 3 | Per-step templates (§7) + variable union (16.2) + skip rows + breaker | |
| 4 | Conversation collection (§8) + the §15.1 gate | |
| 5 | Ambiguity clarification (§15) | |

Phase 1 ships **no user-visible change**. A sequence is constructible only from a test —
nothing in the chat path can produce one until phase 4. That is deliberate: it means the
engine can be wrong in private.

## 17.1 Changes

| File | Change |
|---|---|
| `contract.ts` | `Frequency += 'sequence'`; `StepSpec`, `SequenceStep`; `startAt`/`steps` on `WorkflowSchedule`; **a sequence branch in `parseContract`'s schedule parser** |
| `recurrence.ts` | `materializeSequence()`; a sequence branch in `computeNextRunAt` |
| `scheduler.ts` | `exhaustedByLimits` returns false for a sequence |
| `workflow.service.ts` | `modelScheduleToContract` / `contractScheduleToModel` pass-through; a minimal `scheduleLabel` |
| `mail-workflow.model.ts` | enum `+= 'sequence'`; `startAt: Date`; `steps` subdoc (`_id: false`) |

`mail-workflow-run.model.ts` is **not** touched. `templateId` on the run is phase 3 — an
unused column now is scaffolding for later.

## 17.2 Blockers found while planning

Three things would have made phase 1 quietly untestable or wrong. Each is in scope.

**B1 — `parseContract` rejects every sequence.** Its schedule parser (`contract.ts:130`)
runs `String(s.time ?? '')` and throws `'time must be HH:mm'` for anything that is not
`once`. A sequence has no `time`. Without a branch here, nothing can construct one end to
end. Add it directly after the `once` branch.

**B2 — branch placement in `computeNextRunAt`.** The sequence branch must come **before**
the `schedule.time` parse, or it throws `invalid schedule time: undefined` before reaching
the list. It goes first in the function, ahead of the `once` check.

**B3 — `scheduleLabel` falls through to monthly.** `workflow.service.ts:65` returns early
for `once`, `daily`, `weekly`, then *assumes* monthly. A sequence reaching it renders
**"Every month on the 1st at 12:00 AM"** — confidently wrong. Phase 1 adds a minimal
`"3 sends"`; the step table is phase 2.

## 17.3 Engine edge cases

| # | Case | Handling |
|---|---|---|
| E1 | **`steps` not sorted** (hand-edited doc, bad migration) | Scan for the **minimum** instant after the cursor, not the first in array order. Same cost, no ordering assumption — and it keeps `stepTemplateId` honest in phase 3 |
| E2 | **Malformed `at`** | `new Date('garbage') > after` is `false`, so a corrupt step is silently never sent and the workflow reports success. **Throw** instead, matching the existing `invalid schedule time` throw |
| E3 | **Empty or missing `steps`** | Returning `null` marks the workflow `completed` — a corrupt row silently claims to have finished. Throw |
| E4 | Throwing inside a tick | Verified safe: `processDueWorkflow` catches, calls `releaseWorkflow`, rethrows; `runSchedulerTick` catches per workflow and logs `scheduler.claim_failed`. Lease released, other workflows unaffected |
| E5 | **Stray `maxRuns`** on a sequence | `exhaustedByLimits` (`scheduler.ts:140`) would complete it early. Phase 2 strips `maxRuns` at validation, but the engine must not depend on phase 2 — one line here |
| E6 | Stray `endDate` | `endDateReached` is only called inside the recurring loop, so the sequence branch never consults it. Safe today; **assert it**, so a later refactor cannot wire it in |
| E7 | Very large `steps` | Min-scan is O(n) per call. Bounded by validation in phase 2; phase 1 only has to avoid O(n²) |

## 17.4 Materialization edge cases

Covers §16.9 a–g plus five found while planning.

| # | Case | Handling |
|---|---|---|
| M1 | Duplicate instants (`after 60 from start` twice) | Materializer enforces strictly-increasing and throws |
| M2 | `at 00:00, dayOffset 0` — always in the past | Rolls forward. The **computed** roll, not a loop (M8) |
| M3 | DST fall-back: 01:30 occurs twice | `utcFromZoned`'s search takes the earlier instant. Deterministic — document and test it |
| M4 | A true "now" first step | `minutes >= 1` makes zero delay impossible. Allow `0` on **step 1 only**; later steps still need a real gap |
| M5 | Total span | Validate on the **materialized** list, never the specs — 20 × 525600 minutes is 20 years otherwise |
| M6 | Leap day / month end | `addCivilDays` handles it. Test Feb 29 2028 |
| M7 | Workspace timezone changed after creation | Frozen instants are absolute and do not move. Test: materialize, re-read under a different tz, assert identical |
| M8 | **Roll cost** | Rolling day-by-day from `dayOffset` to catch up with `prev` can be 365 iterations × `utcFromZoned`, and each of those is ~40 `Intl.formatToParts` calls — **~14,600 formats**, a visible stall at preview time. Start the roll at `max(startAt + dayOffset, prev's civil date)` and roll at most 2 more days. O(1) |
| M9 | A roll that still lands `<= prev` after starting at `prev`'s day | Only DST can do this. Bound at 3 and throw beyond, rather than looping |
| M10 | Invalid `startAt` | NaN propagates silently through every comparison. Guard at entry |
| M11 | `minutes` NaN / Infinity / negative | Reject. (No overflow risk: 20 × 525600 min is 6.3e11 ms against a 8.64e15 ceiling) |
| M12 | `from: 'start'` producing out-of-order steps | Caught by M1's strictly-increasing rule |

## 17.5 Worst cases

**A corrupt sequence wedges the scheduler.** It does not — E4 traces the path. The lease is
released and the tick continues. This is why E2/E3 throw rather than degrade.

**A sequence silently sends nothing and reports success.** The E2/E3 failure mode: a
malformed step compares `false` against every cursor, `computeNextRunAt` returns `null`,
`finalizeWorkflowAfterRun` sets `status: 'completed'`. The user sees a completed workflow
that sent zero mail. Throwing converts it into a visible failure.

**A sequence fires the wrong step.** E1's unsorted-array case. Min-scan removes the
assumption entirely rather than adding a sort nobody maintains.

**Rollback traps a workflow.** Once a document holds `frequency: 'sequence'`, removing the
value from the Mongo enum makes that document **unsaveable** — it can no longer be paused
or cancelled, only deleted. The enum value must stay permanently, even if the feature is
later disabled. This goes in the model as a comment, not just here.

**Preview stalls.** M8 — 14,600 `Intl` calls inside a request. Mentioned because it is the
only performance cliff in the design, and the fix is O(1).

## 17.6 Tests

All `assert`-based, in existing self-check blocks. No new runner.

`recurrence.ts`

1. Materialize the §2 example (`after 60`, `at 14:00 d0`, `after 120`) → three exact instants
2. An `at` step earlier than the previous one rolls forward exactly one day — assert the **value**, which also pins M8's arithmetic
3. Two `at` steps on one `dayOffset` → distinct and ordered (the same-day requirement)
4. `computeNextRunAt` walks the list and returns `null` past the last step
5. **Unsorted** `steps` still yield the earliest future instant (E1)
6. Malformed `at` throws (E2)
7. Empty `steps` throws (E3)
8. A sequence ignores `endDate` (E6)
9. A sequence spanning spring-forward keeps each `at` step at its stated wall clock
10. Fall-back ambiguity resolves deterministically (M3)
11. Materialized instants are identical when read under a different timezone (M7)
12. Leap day (M6)
13. `minutes: 0` accepted on step 1, rejected on step 2 (M4)
14. Duplicate instants throw (M1)
15. `planCatchUp` on a sequence with three due steps produces **one** send — phase 0's guarantee, now on the schedule kind that made it reachable

`scheduler.ts`

16. `exhaustedByLimits` is false for a sequence carrying a stray `maxRuns` (E5)

`contract.ts`

17. `parseContract` accepts a valid sequence and rejects a malformed one (B1)

`workflow.service.ts`

18. `scheduleLabel` for a sequence does not say "Every month" (B3)

## 17.7 Definition of done

- `npx tsc --noEmit` clean in both projects
- `npm run check:mail` — 10/10, with 18 new assertions inside them
- `npm run check:mail:integration` — 7/7
- **No behaviour change for existing schedules.** The `once`/`daily`/`weekly`/`monthly`
  paths are untouched; every existing assertion passes unmodified
- **Nothing user-facing.** The chat path still cannot produce a sequence — verified by the
  absence of any `'sequence'` literal in `chat-parser.ts` after phase 1

---

## 18. Runtime send safeguards

Enforced in `send-guard.ts` and `send-executor.ts` before each recipient dispatch. These are
**runtime** limits — separate from the UX/structure caps in §5.

| Guard | Limit | On breach |
|---|---|---|
| Per-mailbox send pace | ≤ 20 messages/min | Defer run (`nextAttemptAt`) |
| Per-mailbox concurrency | ≤ 2 in-flight (`sending` recipients) | Defer |
| Per-mailbox recipients/day (soft) | ≤ 8000 | Defer until next UTC day |
| Tenant external recipients/day | ≤ 80% of TERRL | Defer |

**TERRL unknown:** conservative fallback — assume 10,000 external recipients/day (common
M365 default) and cap at 8,000 (80%). Set `MAIL_TENANT_EXTERNAL_RECIPIENT_LIMIT` when the
tenant limit is known.

**Retry policy** (`retry.ts`): retry only Graph `429`, `503`, `504`. Honor `Retry-After`
when present; exponential backoff (10s → 30s → 90s) otherwise. Auth (`401`/`403`) and other
errors are not retried.

**Telemetry:** `send.guard_deferred`, `send.draft_failed`, `send.send_failed`, and
`run.retry_scheduled` log reason, `retryAfterMs`, in-flight count, pace count, daily counts,
and configured caps for ops/debug.
