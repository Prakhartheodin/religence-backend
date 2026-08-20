import { Router, type Request } from 'express';
import { HttpError } from '../http-error.js';
import { WorkflowError, parseContract, type RunStatus } from '../services/mail-workflow/contract.js';
import {
  cancelWorkflow,
  createWorkflow,
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
