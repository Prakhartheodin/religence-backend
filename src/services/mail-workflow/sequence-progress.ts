import assert from 'node:assert/strict';

import { CrmEntities } from '../../models/crm-entities.js';
import { MailWorkflowRunModel } from '../../models/mail-workflow-run.model.js';
import { MailWorkflowModel } from '../../models/mail-workflow.model.js';
import { listEmailTemplates } from '../email-templates.service.js';
import { WorkflowError } from './contract.js';
import type { StepSpec, WorkflowStatus } from './contract.js';
import { computeNextRunAt, stepTemplateId } from './recurrence.js';
import { loadOwnedLeads, modelScheduleToContract } from './workflow.service.js';

export type SequenceStepStatus = 'sent' | 'pending' | 'failed' | 'skipped';

export type SequenceStepProgress = {
  index: number;
  at: string;
  spec: StepSpec;
  templateId: string;
  templateName: string;
  status: SequenceStepStatus;
  sentAt: string | null;
};

export type SequenceProgressItem = {
  workflowId: string;
  name: string;
  subjectLabel: string;
  status: string;
  contact: { id: string; name: string; email: string; company: string };
  timezone: string;
  totalSteps: number;
  sentSteps: number;
  remainingSteps: number;
  remainingCount: number;
  nextPendingAt: string | null;
  startAt: string | null;
  steps: SequenceStepProgress[];
};

const IN_PROGRESS: WorkflowStatus[] = ['active', 'paused', 'paused_auth_required', 'pending_confirm'];

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function runStepStatus(
  run: { status: string; recipients?: Array<{ status: string; acceptedAt?: Date | null }> },
): SequenceStepStatus {
  if (run.status === 'skipped') return 'skipped';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'running') return 'pending';
  const recipients = run.recipients ?? [];
  if (recipients.some((r) => r.status === 'failed')) return 'failed';
  if (recipients.some((r) => r.status === 'sent')) return 'sent';
  if (run.status === 'success' || run.status === 'partial_success') return 'sent';
  return 'pending';
}

function sentAtFromRun(
  run: { recipients?: Array<{ acceptedAt?: Date | null }> },
): string | null {
  for (const r of run.recipients ?? []) {
    const iso = toIso(r.acceptedAt);
    if (iso) return iso;
  }
  return null;
}

export async function buildSequenceProgress(
  userId: string,
  workflowId: string,
): Promise<SequenceProgressItem> {
  const wf = await MailWorkflowModel.findOne({ userId, id: workflowId }).lean();
  if (!wf) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'workflow not found');

  const schedule = modelScheduleToContract(wf.schedule);
  if (schedule.frequency !== 'sequence') {
    throw new WorkflowError('CONTRACT_INVALID', 'not a sequence workflow', 400);
  }

  const steps = schedule.steps ?? [];
  const [runs, templates, leads] = await Promise.all([
    MailWorkflowRunModel.find({ userId, workflowId }).lean(),
    listEmailTemplates(userId),
    wf.recipientIds.length ? loadOwnedLeads(userId, wf.recipientIds).catch(() => []) : Promise.resolve([]),
  ]);

  const templateNameById = new Map(templates.map((t) => [t.id, t.name]));
  const runByAt = new Map(
    runs.map((run) => [new Date(run.scheduledAt).toISOString(), run]),
  );

  const lead = leads[0];
  const defaultTemplateName = templateNameById.get(wf.templateId) ?? wf.templateId;

  const stepRows: SequenceStepProgress[] = steps.map((step, i) => {
    const at = new Date(step.at).toISOString();
    const templateId = step.templateId ?? stepTemplateId(schedule, new Date(at)) ?? wf.templateId;
    const run = runByAt.get(at);
    return {
      index: i + 1,
      at,
      spec: step.spec,
      templateId,
      templateName: templateNameById.get(templateId) ?? defaultTemplateName,
      status: run ? runStepStatus(run) : 'pending',
      sentAt: run ? sentAtFromRun(run) : null,
    };
  });

  const sentSteps = stepRows.filter((s) => s.status === 'sent').length;
  const remainingSteps = stepRows.filter((s) => s.status === 'pending' || s.status === 'failed').length;

  const nextPendingAt =
    toIso(wf.nextRunAt)
    ?? toIso(
      computeNextRunAt(schedule, wf.timezone, new Date(), {
        afterOccurrence: wf.lastRunAt ?? new Date(0),
      }),
    );

  return {
    workflowId: wf.id,
    name: defaultTemplateName,
    subjectLabel: defaultTemplateName,
    status: wf.status,
    contact: {
      id: lead?.id ?? wf.recipientIds[0] ?? '',
      name: lead?.contactName ?? 'Unknown contact',
      email: lead?.contactEmail ?? '',
      company: lead?.companyName ?? '',
    },
    timezone: wf.timezone,
    totalSteps: stepRows.length,
    sentSteps,
    remainingSteps,
    remainingCount: remainingSteps,
    nextPendingAt,
    startAt: schedule.startAt ?? steps[0]?.at ?? null,
    steps: stepRows,
  };
}

export async function listSequenceProgress(userId: string): Promise<SequenceProgressItem[]> {
  const workflows = await MailWorkflowModel.find({
    userId,
    status: { $in: IN_PROGRESS },
    'schedule.frequency': 'sequence',
  })
    .sort({ updatedAt: -1 })
    .lean();

  const items: SequenceProgressItem[] = [];
  for (const wf of workflows) {
    items.push(await buildSequenceProgress(userId, wf.id));
  }
  return items;
}

if (process.argv[1]?.endsWith('sequence-progress.ts')) {
  const sent = runStepStatus({
    status: 'success',
    recipients: [{ status: 'sent', acceptedAt: new Date('2026-08-21T10:00:00Z') }],
  });
  assert.equal(sent, 'sent');
  assert.equal(runStepStatus({ status: 'skipped', recipients: [] }), 'skipped');
  assert.equal(
    runStepStatus({ status: 'running', recipients: [{ status: 'pending' }] }),
    'pending',
  );
  console.log('sequence-progress self-check passed');
}
