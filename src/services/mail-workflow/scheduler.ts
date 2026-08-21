import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  MailWorkflowModel,
  type MailWorkflowDocument,
} from '../../models/mail-workflow.model.js';
import { MailWorkflowRunModel } from '../../models/mail-workflow-run.model.js';
import { type RunStatus } from './contract.js';
import { mailLog } from './log.js';
import { computeNextRunAt, planCatchUp, stepTemplateId, type CatchUpPlan } from './recurrence.js';
import { providerIdempotencyKey } from './retry.js';
import { newRunRecipients, runExecutorPass } from './send-executor.js';
import {
  isDuplicateKeyError,
  loadOwnedLeads,
  modelScheduleToContract,
} from './workflow.service.js';

const CLAIM_LEASE_MS = 60 * 1000;
const BATCH_SIZE = 20;

let ticking = false;

export function terminalRunStatus(status: RunStatus): boolean {
  return status !== 'running';
}

function leaseOwnerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

/**
 * Claim a workflow just long enough to create its occurrence row and advance nextRunAt.
 * The lease is short because no sending happens under it — that is the executor's job.
 */
async function claimWorkflow(wf: MailWorkflowDocument, now: Date): Promise<MailWorkflowDocument | null> {
  const lockId = randomUUID();
  return MailWorkflowModel.findOneAndUpdate(
    {
      id: wf.id,
      userId: wf.userId,
      status: 'active',
      nextRunAt: { $lte: now },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
    },
    {
      $set: {
        leaseOwner: leaseOwnerId(),
        lockId,
        leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS),
      },
    },
    { returnDocument: 'after' },
  ).lean();
}

async function releaseWorkflow(
  workflowId: string,
  lockId: string,
  update: Record<string, unknown> = {},
): Promise<void> {
  await MailWorkflowModel.updateOne(
    { id: workflowId, lockId },
    { $set: { ...update, leaseOwner: null, leaseUntil: null, lockId: null } },
  );
}

/** Record that occurrences were skipped, so the gap is visible in run history. */
async function recordSkippedOccurrence(
  wf: MailWorkflowDocument,
  occurrence: Date,
  skipped: number,
): Promise<void> {
  try {
    await MailWorkflowRunModel.create({
      id: randomUUID(),
      workflowId: wf.id,
      userId: wf.userId,
      scheduledAt: occurrence,
      status: 'skipped',
      sendState: 'failed',
      attemptCount: 0,
      attempts: [],
      recipients: [],
      providerIdempotencyKey: providerIdempotencyKey(wf.userId, wf.id, occurrence),
      templateId: stepTemplateId(modelScheduleToContract(wf.schedule), occurrence) ?? wf.templateId,
      skipReason:
        skipped > 1
          ? `STALE_OCCURRENCE (${skipped} missed while the scheduler was unavailable)`
          : 'STALE_OCCURRENCE',
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/**
 * Create the run row for one occurrence. Unique (workflowId, scheduledAt) makes this
 * safe under concurrent ticks — a duplicate simply means another worker got there first.
 */
async function createOccurrenceRun(
  wf: MailWorkflowDocument,
  occurrence: Date,
): Promise<boolean> {
  let recipients: ReturnType<typeof newRunRecipients> = [];
  try {
    const leads = await loadOwnedLeads(wf.userId, wf.recipientIds);
    recipients = newRunRecipients(leads);
  } catch {
    // Leave recipients empty; the executor records RECIPIENT_NOT_FOUND and skips the run.
    recipients = [];
  }

  try {
    await MailWorkflowRunModel.create({
      id: randomUUID(),
      workflowId: wf.id,
      userId: wf.userId,
      scheduledAt: occurrence,
      status: 'running',
      sendState: 'scheduled',
      attemptCount: 0,
      attempts: [],
      recipients,
      providerIdempotencyKey: providerIdempotencyKey(wf.userId, wf.id, occurrence),
      templateId: stepTemplateId(modelScheduleToContract(wf.schedule), occurrence) ?? wf.templateId,
      nextAttemptAt: null,
    });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

export function planForWorkflow(wf: MailWorkflowDocument, now: Date): CatchUpPlan {
  return planCatchUp(modelScheduleToContract(wf.schedule), wf.timezone, wf.nextRunAt, now);
}

/** True when the workflow has hit its own stop condition regardless of the clock. */
export function exhaustedByLimits(wf: MailWorkflowDocument): boolean {
  const schedule = modelScheduleToContract(wf.schedule);
  // A sequence ends by running out of steps, never by a run count.
  if (schedule.frequency === 'sequence') return false;
  if (schedule.maxRuns != null && wf.runCount >= schedule.maxRuns) return true;
  return false;
}

async function processDueWorkflow(wf: MailWorkflowDocument, now: Date): Promise<void> {
  const claimed = await claimWorkflow(wf, now);
  if (!claimed?.lockId) return;
  const lockId = claimed.lockId;
  const ctx = {
    workspaceId: claimed.userId,
    userId: claimed.userId,
    workflowId: claimed.id,
  };

  try {
    if (exhaustedByLimits(claimed)) {
      await releaseWorkflow(claimed.id, lockId, { status: 'completed', nextRunAt: null });
      mailLog.info('workflow.completed_max_runs', ctx);
      return;
    }

    const plan = planForWorkflow(claimed, now);

    if (plan.action === 'wait') {
      await releaseWorkflow(claimed.id, lockId);
      return;
    }

    if (plan.action === 'complete') {
      await releaseWorkflow(claimed.id, lockId, { status: 'completed', nextRunAt: null });
      mailLog.info('workflow.completed', ctx);
      return;
    }

    if (plan.action === 'skip') {
      const skippedList = plan.skippedOccurrences.length
        ? plan.skippedOccurrences
        : [plan.lastSkipped];
      for (const skippedAt of skippedList) {
        await recordSkippedOccurrence(claimed, skippedAt, 1);
      }
      mailLog.warn('scheduler.stale_occurrences_skipped', {
        ...ctx,
        skipped: plan.skipped,
        lastSkipped: plan.lastSkipped,
      });

      if (plan.runNow) {
        const created = await createOccurrenceRun(claimed, plan.runNow);
        const next = computeNextRunAt(
          modelScheduleToContract(claimed.schedule),
          claimed.timezone,
          now,
          { afterOccurrence: plan.runNow },
        );
        await releaseWorkflow(claimed.id, lockId, { nextRunAt: next });
        if (created) mailLog.info('scheduler.occurrence_claimed', { ...ctx, occurrence: plan.runNow });
        return;
      }

      await releaseWorkflow(claimed.id, lockId, {
        nextRunAt: plan.nextRunAt,
        ...(plan.nextRunAt ? {} : { status: 'completed' }),
      });
      return;
    }

    // plan.action === 'run'
    const created = await createOccurrenceRun(claimed, plan.occurrence);
    const next = computeNextRunAt(
      modelScheduleToContract(claimed.schedule),
      claimed.timezone,
      now,
      { afterOccurrence: plan.occurrence },
    );
    await releaseWorkflow(claimed.id, lockId, { nextRunAt: next });
    if (created) {
      mailLog.info('scheduler.occurrence_claimed', { ...ctx, occurrence: plan.occurrence });
    }
  } catch (err) {
    await releaseWorkflow(claimed.id, lockId);
    throw err;
  }
}

/**
 * One scheduler tick: claim due occurrences (fast, never sends), then run an executor
 * pass (sends, but never sleeps). Both halves are bounded so the loop stays responsive.
 */
export async function runSchedulerTick(now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = await MailWorkflowModel.find({
      status: 'active',
      nextRunAt: { $ne: null, $lte: now },
    })
      .limit(BATCH_SIZE)
      .lean();

    for (const wf of due) {
      try {
        await processDueWorkflow(wf, now);
      } catch (err) {
        mailLog.error('scheduler.claim_failed', {
          workspaceId: wf.userId,
          userId: wf.userId,
          workflowId: wf.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await runExecutorPass(now);
  } finally {
    ticking = false;
  }
}

if (process.argv[1]?.endsWith('scheduler.ts')) {
  const now = new Date('2026-08-25T05:00:00.000Z'); // 10:30 IST
  const base = {
    id: 'wf-1',
    userId: 'u1',
    status: 'active' as const,
    executionMode: 'recurring' as const,
    nextRunAt: new Date('2026-08-25T04:30:00.000Z'),
    runCount: 0,
    timezone: 'Asia/Kolkata',
    schedule: { frequency: 'daily' as const, timeOfDay: '10:00' },
  } as unknown as MailWorkflowDocument;

  assert.equal(planForWorkflow(base, now).action, 'run');

  // not due yet
  assert.equal(
    planForWorkflow({ ...base, nextRunAt: new Date('2026-08-26T04:30:00Z') } as MailWorkflowDocument, now).action,
    'wait',
  );

  // 3-day outage must not produce 3 sends
  const storm = planForWorkflow(
    { ...base, nextRunAt: new Date('2026-08-22T04:30:00Z') } as MailWorkflowDocument,
    now,
  );
  assert.equal(storm.action, 'skip');
  if (storm.action === 'skip') {
    assert.equal(storm.skipped, 3);
    assert.equal(storm.runNow?.toISOString(), '2026-08-25T04:30:00.000Z');
    assert.equal(storm.skippedOccurrences.length, 3);
  }

  // maxRuns is enforced before anything is claimed
  assert.equal(
    exhaustedByLimits({
      ...base,
      runCount: 3,
      schedule: { frequency: 'daily', timeOfDay: '10:00', maxRuns: 3 },
    } as unknown as MailWorkflowDocument),
    true,
  );
  assert.equal(exhaustedByLimits(base), false);

  assert.equal(
    exhaustedByLimits({
      ...base,
      runCount: 5,
      schedule: {
        frequency: 'sequence',
        startAt: new Date(),
        steps: [{ spec: { kind: 'after', minutes: 60, from: 'previous' }, at: new Date() }],
        maxRuns: 1,
      },
    } as unknown as MailWorkflowDocument),
    false,
    'sequence ignores maxRuns',
  );

  // once-schedule shape flows through the planner
  const onceWf = {
    ...base,
    executionMode: 'once' as const,
    nextRunAt: new Date('2026-08-25T04:45:00Z'),
    schedule: { frequency: 'once' as const, runAt: new Date('2026-08-25T04:45:00Z') },
  } as unknown as MailWorkflowDocument;
  assert.equal(planForWorkflow(onceWf, now).action, 'run');

  assert.equal(terminalRunStatus('success'), true);
  assert.equal(terminalRunStatus('partial_success'), true);
  assert.equal(terminalRunStatus('unknown'), true);
  assert.equal(terminalRunStatus('running'), false);

  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 11001 }), false);

  console.log('scheduler self-check passed');
}
