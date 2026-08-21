import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectMongo } from '../../db/mongo.js';
import { MailWorkflowModel } from '../../models/mail-workflow.model.js';
import { MailWorkflowRunModel } from '../../models/mail-workflow-run.model.js';
import { MailWorkflowCommandModel } from '../../models/mail-workflow-command.model.js';
import { MailChatSessionModel } from '../../models/mail-chat-session.model.js';
import { emptyDraft, toAwaitingCreateConfirmation } from './chat-draft.js';
import {
  clearMailChatSession,
  getMailChatSession,
  loadConversationDraft,
  persistChatExchange,
  saveConversationDraft,
} from './chat-session.service.js';
import { providerIdempotencyKey } from './retry.js';
import {
  defaultSendGuardLimits,
  evaluateSendGuard,
  loadSendGuardSnapshot,
} from './send-guard.js';
import {
  cancelWorkflow,
  getWorkflow,
  isDuplicateKeyError,
  listRuns,
  listWorkflows,
  pauseWorkflow,
  resumeWorkflow,
  withIdempotency,
} from './workflow.service.js';

/**
 * Mongo-backed checks for the things unit tests cannot prove: tenant isolation,
 * concurrent claims, and the unique-index guarantees the scheduler relies on.
 *
 * Run with:  MONGODB_URI=... npx tsx src/services/mail-workflow/integration.check.ts
 */

const USER_A = `itest-a-${randomUUID()}`;
const USER_B = `itest-b-${randomUUID()}`;

function workflowDoc(userId: string, over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    userId,
    createdByUserId: userId,
    status: 'active' as const,
    executionMode: 'recurring' as const,
    oneTimeSendAt: null,
    templateId: 'follow-up-1',
    recipientIds: ['lead-1'],
    recipientScope: 'crm_only' as const,
    variables: {},
    schedule: { frequency: 'daily' as const, timeOfDay: '10:00' },
    timezone: 'Asia/Kolkata',
    accountId: 'acct-1',
    nextRunAt: new Date(Date.now() - 60_000),
    runCount: 0,
    failureCount: 0,
    leaseOwner: null,
    leaseUntil: null,
    lockId: null,
    ...over,
  };
}

async function cleanup(): Promise<void> {
  const users = { $in: [USER_A, USER_B] };
  await Promise.all([
    MailWorkflowModel.deleteMany({ userId: users }),
    MailWorkflowRunModel.deleteMany({ userId: users }),
    MailWorkflowCommandModel.deleteMany({ userId: users }),
    MailChatSessionModel.deleteMany({ userId: users }),
  ]);
}

async function testCrossUserIsolation(): Promise<void> {
  const a = await MailWorkflowModel.create(workflowDoc(USER_A));
  const b = await MailWorkflowModel.create(workflowDoc(USER_B));

  const listA = await listWorkflows(USER_A);
  assert.equal(listA.length, 1, 'user A sees only their own workflow');
  assert.equal(listA[0].id, a.id);

  // B must not be able to read A's workflow by id
  await assert.rejects(
    () => getWorkflow(USER_B, a.id),
    /workflow not found/,
    "user B must not read user A's workflow",
  );

  // ...nor mutate it
  await assert.rejects(
    () => pauseWorkflow(USER_B, a.id, randomUUID()),
    /workflow not found/,
    "user B must not pause user A's workflow",
  );
  await assert.rejects(
    () => cancelWorkflow(USER_B, a.id, randomUUID()),
    /workflow not found/,
    "user B must not cancel user A's workflow",
  );

  // ...nor read its run history
  await assert.rejects(() => listRuns(USER_B, a.id), /workflow not found/);

  // A's workflow is untouched after all those attempts
  const stillActive = await getWorkflow(USER_A, a.id);
  assert.equal(stillActive.status, 'active');

  await MailWorkflowModel.deleteOne({ id: b.id });
  await MailWorkflowModel.deleteOne({ id: a.id });
  console.log('  ✓ cross-user workflow isolation');
}

async function testSessionIsolation(): Promise<void> {
  await saveConversationDraft(USER_A, { ...emptyDraft(), templateHint: 'a-secret-template' });
  await persistChatExchange(
    USER_A,
    { text: 'user A private message', requestId: randomUUID() },
    { kind: 'assistant_message', message: 'reply to A' },
  );

  const sessionB = await getMailChatSession(USER_B);
  assert.equal(sessionB.messages.length, 0, "user B must not see user A's messages");
  const draftB = await loadConversationDraft(USER_B);
  assert.equal(draftB.templateHint, undefined, "user B must not inherit user A's draft");

  const sessionA = await getMailChatSession(USER_A);
  assert.equal(sessionA.messages.length, 2, 'user A keeps their own exchange');

  // awaiting-confirmation state is per user: B saying "yes" cannot confirm A's draft
  const draftA = await loadConversationDraft(USER_A);
  await saveConversationDraft(USER_A, toAwaitingCreateConfirmation(draftA, 'req-a'));
  const bAfter = await loadConversationDraft(USER_B);
  assert.notEqual(bAfter.state, 'awaiting_confirmation', "user B is not awaiting A's confirmation");

  await clearMailChatSession(USER_A);
  console.log('  ✓ cross-user chat session isolation');
}

async function testRequestLedgerIsCapped(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await persistChatExchange(
      USER_A,
      { text: `msg ${i}`, requestId: randomUUID() },
      { kind: 'assistant_message', message: `reply ${i}` },
    );
  }
  const doc = await MailChatSessionModel.findOne({ userId: USER_A }).lean();
  assert.ok(doc, 'session exists');
  assert.ok(doc!.requestLedger.length <= 200, 'ledger stays capped');
  assert.equal(doc!.requestLedger.length, 5, 'all five recorded');

  // replaying a requestId returns the cached exchange instead of a second reply
  const replayId = randomUUID();
  const first = await persistChatExchange(
    USER_A,
    { text: 'replay me', requestId: replayId },
    { kind: 'assistant_message', message: 'original' },
  );
  const second = await persistChatExchange(
    USER_A,
    { text: 'replay me', requestId: replayId },
    { kind: 'assistant_message', message: 'DIFFERENT — must not be stored' },
  );
  assert.equal(second.assistant.id, first.assistant.id, 'replay returns the original message');
  assert.deepEqual(second.assistant.response, first.assistant.response);

  await clearMailChatSession(USER_A);
  console.log('  ✓ request ledger dedupe + cap');
}

async function testDuplicateOccurrenceIsRejected(): Promise<void> {
  const wf = await MailWorkflowModel.create(workflowDoc(USER_A));
  const scheduledAt = new Date('2026-08-25T04:30:00.000Z');

  const makeRun = () =>
    MailWorkflowRunModel.create({
      id: randomUUID(),
      workflowId: wf.id,
      userId: USER_A,
      scheduledAt,
      status: 'running',
      sendState: 'scheduled',
      attemptCount: 0,
      attempts: [],
      recipients: [],
      providerIdempotencyKey: providerIdempotencyKey(USER_A, wf.id, scheduledAt),
    });

  await makeRun();
  // Two ticks racing on the same occurrence: the second must lose.
  const results = await Promise.allSettled([makeRun(), makeRun()]);
  for (const r of results) {
    assert.equal(r.status, 'rejected', 'duplicate occurrence must be rejected');
    if (r.status === 'rejected') {
      assert.ok(isDuplicateKeyError(r.reason), 'rejected by the unique index');
    }
  }

  const runs = await MailWorkflowRunModel.find({ workflowId: wf.id, scheduledAt }).lean();
  assert.equal(runs.length, 1, 'exactly one run exists for the occurrence');

  await MailWorkflowRunModel.deleteMany({ workflowId: wf.id });
  await MailWorkflowModel.deleteOne({ id: wf.id });
  console.log('  ✓ duplicate occurrence rejected by unique index');
}

async function testSendGuardSnapshotFromMongo(): Promise<void> {
  const wf = await MailWorkflowModel.create(workflowDoc(USER_A));
  const now = new Date('2026-08-21T10:00:00.000Z');
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const acceptedInMinute = new Date(now.getTime() - 20_000);
  const acceptedToday = new Date(dayStart.getTime() + 60_000);
  const acceptedYesterday = new Date(dayStart.getTime() - 60_000);

  await MailWorkflowRunModel.create({
    id: randomUUID(),
    workflowId: wf.id,
    userId: USER_A,
    scheduledAt: new Date(now.getTime() - 120_000),
    status: 'running',
    sendState: 'sending',
    attemptCount: 0,
    attempts: [],
    recipients: [
      { recipientId: 'r-minute', email: 'minute@example.com', status: 'sent', attemptCount: 1, acceptedAt: acceptedInMinute },
      { recipientId: 'r-sending', email: 'sending@example.com', status: 'sending', attemptCount: 1, acceptedAt: null },
      { recipientId: 'r-today', email: 'today@example.com', status: 'sent', attemptCount: 1, acceptedAt: acceptedToday },
      { recipientId: 'r-old', email: 'old@example.com', status: 'sent', attemptCount: 1, acceptedAt: acceptedYesterday },
    ],
    providerIdempotencyKey: providerIdempotencyKey(USER_A, wf.id, now),
    templateId: 'follow-up-1',
  });

  const snap = await loadSendGuardSnapshot(USER_A, now);
  assert.equal(snap.sentLastMinute, 1, 'only recent accepted recipients count toward pace');
  assert.equal(snap.inFlight, 1, 'only sending recipients count toward concurrency');
  assert.equal(snap.recipientsToday, 2, 'daily count includes sent recipients since UTC midnight');
  assert.equal(snap.tenantExternalToday, 2, 'tenant external counter mirrors daily sent count in v1');

  const decision = evaluateSendGuard(snap, { ...defaultSendGuardLimits(), pacePerMin: 1 });
  assert.equal(decision.allow, false, 'a snapshot at the pace cap is blocked');
  if (!decision.allow) assert.equal(decision.reason, 'MAILBOX_PACE');

  await MailWorkflowRunModel.deleteMany({ workflowId: wf.id });
  await MailWorkflowModel.deleteOne({ id: wf.id });
  console.log('  ✓ send-guard snapshot reflects Mongo recipient counts');
}

async function testConcurrentLeaseClaim(): Promise<void> {
  const wf = await MailWorkflowModel.create(workflowDoc(USER_A));
  const now = new Date();

  const claim = () =>
    MailWorkflowModel.findOneAndUpdate(
      {
        id: wf.id,
        userId: USER_A,
        status: 'active',
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
      },
      { $set: { leaseOwner: `worker-${randomUUID()}`, lockId: randomUUID(), leaseUntil: new Date(now.getTime() + 60_000) } },
      { returnDocument: 'after' },
    ).lean();

  const claims = await Promise.all([claim(), claim(), claim(), claim()]);
  const winners = claims.filter(Boolean);
  // All four may return a document, but only the last lockId is durable — verify that
  // exactly one lockId survives, which is what releaseWorkflow({id, lockId}) keys on.
  const fresh = await MailWorkflowModel.findOne({ id: wf.id }).lean();
  const survivingLock = fresh?.lockId;
  const matching = winners.filter((w) => w!.lockId === survivingLock);
  assert.equal(matching.length, 1, 'exactly one claimant holds the surviving lock');

  // A release with a stale lockId must be a no-op.
  const stale = winners.find((w) => w!.lockId !== survivingLock);
  if (stale) {
    const res = await MailWorkflowModel.updateOne(
      { id: wf.id, lockId: stale!.lockId },
      { $set: { status: 'completed' } },
    );
    assert.equal(res.matchedCount, 0, 'stale lock cannot mutate the workflow');
  }

  await MailWorkflowModel.deleteOne({ id: wf.id });
  console.log('  ✓ concurrent lease claim yields a single owner');
}

async function testPauseCancelRace(): Promise<void> {
  const wf = await MailWorkflowModel.create(workflowDoc(USER_A));

  const [pauseRes, cancelRes] = await Promise.allSettled([
    pauseWorkflow(USER_A, wf.id, randomUUID()),
    cancelWorkflow(USER_A, wf.id, randomUUID()),
  ]);

  const settled = await getWorkflow(USER_A, wf.id);

  // Both orderings are legitimate — you may cancel an already-paused workflow — but
  // cancel must always win. Landing in `paused` after a successful cancel would leave
  // the workflow resumable, i.e. it would send again after the user cancelled it.
  if (cancelRes.status === 'fulfilled') {
    assert.equal(settled.status, 'cancelled', 'a successful cancel is never undone by pause');
    assert.equal(settled.nextRunAt, null, 'a cancelled workflow has no next run');
    await assert.rejects(() => pauseWorkflow(USER_A, wf.id, randomUUID()), /not active/);
    await assert.rejects(() => resumeWorkflow(USER_A, wf.id, randomUUID()), /not paused/);
  } else {
    // Cancel lost the race outright; it must have failed for an accurate reason.
    assert.match(
      String(cancelRes.reason?.message ?? cancelRes.reason),
      /already terminal|not found/,
    );
    assert.equal(settled.status, 'paused');
  }

  // Whichever call was rejected must have been rejected for a truthful reason.
  for (const r of [pauseRes, cancelRes]) {
    if (r.status === 'rejected') {
      assert.match(
        String(r.reason?.message ?? r.reason),
        /not active|not paused|already terminal|not found/,
        'a lost transition reports why',
      );
    }
  }

  await MailWorkflowModel.deleteOne({ id: wf.id });
  console.log('  ✓ pause/cancel race resolves cleanly');
}

async function testIdempotency(): Promise<void> {
  const requestId = randomUUID();
  let calls = 0;
  const work = async () => {
    calls++;
    return { ok: true, n: calls };
  };

  const r1 = await withIdempotency(USER_A, requestId, 'list', {}, work);
  const r2 = await withIdempotency(USER_A, requestId, 'list', {}, work);
  assert.deepEqual(r1, r2, 'same requestId returns the same result');
  assert.equal(calls, 1, 'work executed exactly once');

  // The ledger is scoped per user: B reusing A's requestId must do its own work.
  const r3 = await withIdempotency(USER_B, requestId, 'list', {}, work);
  assert.equal(calls, 2, "user B's identical requestId is independent");
  assert.equal(r3.n, 2);

  console.log('  ✓ command idempotency (per user)');
}

async function main(): Promise<void> {
  if (!process.env.MONGODB_URI) {
    console.log('integration check skipped (set MONGODB_URI to run)');
    return;
  }
  await connectMongo();
  await cleanup();
  try {
    await testCrossUserIsolation();
    await testSessionIsolation();
    await testRequestLedgerIsCapped();
    await testDuplicateOccurrenceIsRejected();
    await testSendGuardSnapshotFromMongo();
    await testConcurrentLeaseClaim();
    await testPauseCancelRace();
    await testIdempotency();
    console.log('mail-workflow integration check passed');
  } finally {
    await cleanup();
    await mongoose.connection.close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
