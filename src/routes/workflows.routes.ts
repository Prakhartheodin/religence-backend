import { Router, type Request } from 'express';
import { HttpError } from '../http-error.js';
import { WorkflowError, parseContract, type RunStatus } from '../services/mail-workflow/contract.js';
import { listMailHistory, resolveMailLink } from '../services/mail-workflow/mail-history.js';
import { buildSequenceProgress, listSequenceProgress } from '../services/mail-workflow/sequence-progress.js';
import {
  cancelWorkflow,
  confirmWorkflow,
  createWorkflow,
  listRunsNeedingReview,
  getWorkflow,
  listExecutions,
  listRuns,
  listWorkflows,
  pauseWorkflow,
  resumeWorkflow,
  updateWorkflow,
} from '../services/mail-workflow/workflow.service.js';

export const workflowsRouter = Router();
export const executionsRouter = Router();

function requireUserId(req: Request): string {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) throw new HttpError(401, 'authentication required');
  return userId;
}

function asString(value: unknown, field: string): string {
  const v = String(value ?? '').trim();
  if (!v) throw new HttpError(400, `${field} is required`);
  return v;
}

function mapWorkflowError(err: WorkflowError): HttpError {
  return new HttpError(err.httpStatus, err.message, { code: err.code });
}

function handleWorkflowErr(err: unknown, next: (err: unknown) => void): void {
  if (err instanceof WorkflowError) return next(mapWorkflowError(err));
  next(err);
}

workflowsRouter.post('/', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const contract = parseContract(req.body);
    const confirmed = Boolean(req.body?.confirmed);
    const result = await createWorkflow(userId, contract, { confirmed });
    res.status(confirmed ? 201 : 200).json(result);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.get('/', async (req, res, next) => {
  try {
    const workflows = await listWorkflows(requireUserId(req));
    res.json(workflows);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

/** Runs whose provider outcome could not be determined — check the mailbox before resending. */
workflowsRouter.get('/needs-review', async (req, res, next) => {
  try {
    const runs = await listRunsNeedingReview(requireUserId(req));
    res.json(runs);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

/**
 * Per-contact mail timeline. MUST stay above the `/:id` route below, or Express hands
 * "mail-history" to it as a workflow id.
 */
/** In-progress multi-step sequences with per-step send status. */
workflowsRouter.get('/sequence-progress', async (req, res, next) => {
  try {
    const items = await listSequenceProgress(requireUserId(req));
    res.json(items);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.get('/:id/sequence-progress', async (req, res, next) => {
  try {
    const item = await buildSequenceProgress(requireUserId(req), asString(req.params.id, 'id'));
    res.json(item);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.get('/mail-history', async (req, res, next) => {
  try {
    const contactId = String(req.query.contactId ?? '').trim();
    const contacts = await listMailHistory(requireUserId(req), {
      ...(contactId ? { contactId } : {}),
    });
    res.json(contacts);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

/** Resolve one timeline row to its real message in the mailbox. Called on click only. */
workflowsRouter.get('/mail-history/:runId/:recipientId/link', async (req, res, next) => {
  try {
    const link = await resolveMailLink(
      requireUserId(req),
      asString(req.params.runId, 'runId'),
      asString(req.params.recipientId, 'recipientId'),
    );
    res.json(link);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

/** Activate a workflow that was parked awaiting authentication. Requires explicit intent. */
workflowsRouter.post('/:id/confirm', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const workflowId = asString(req.params.id, 'id');
    const requestId = asString(req.body?.requestId, 'requestId');
    const workflow = await confirmWorkflow(userId, workflowId, requestId);
    res.json(workflow);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const runs = await listRuns(requireUserId(req), asString(req.params.id, 'id'));
    res.json(runs);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.get('/:id', async (req, res, next) => {
  try {
    const workflow = await getWorkflow(requireUserId(req), asString(req.params.id, 'id'));
    res.json(workflow);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.patch('/:id', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const workflowId = asString(req.params.id, 'id');
    const contract = parseContract({ ...req.body, action: 'update', workflowId });
    const workflow = await updateWorkflow(userId, workflowId, contract);
    res.json(workflow);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.post('/:id/pause', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const workflowId = asString(req.params.id, 'id');
    const requestId = asString(req.body?.requestId, 'requestId');
    const workflow = await pauseWorkflow(userId, workflowId, requestId);
    res.json(workflow);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.post('/:id/resume', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const workflowId = asString(req.params.id, 'id');
    const requestId = asString(req.body?.requestId, 'requestId');
    const workflow = await resumeWorkflow(userId, workflowId, requestId);
    res.json(workflow);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

workflowsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const workflowId = asString(req.params.id, 'id');
    const requestId = asString(req.body?.requestId, 'requestId');
    const workflow = await cancelWorkflow(userId, workflowId, requestId);
    res.json(workflow);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});

executionsRouter.get('/', async (req, res, next) => {
  try {
    const status = req.query.status ? (String(req.query.status) as RunStatus) : undefined;
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    const runs = await listExecutions(requireUserId(req), { status, from, to });
    res.json(runs);
  } catch (err) {
    handleWorkflowErr(err, next);
  }
});
