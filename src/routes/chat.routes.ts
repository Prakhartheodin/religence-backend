import { Router, type Request } from 'express';
import { HttpError } from '../http-error.js';
import { WorkflowError } from '../services/mail-workflow/contract.js';
import { handleChatMessage } from '../services/mail-workflow/chat-parser.js';

export const chatRouter = Router();

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

chatRouter.post('/message', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const text = asString(req.body?.text, 'text');
    const requestId = asString(req.body?.requestId, 'requestId');
    const confirm = req.body?.confirm;
    const result = await handleChatMessage(userId, {
      text,
      requestId,
      ...(confirm?.workflowId && confirm?.action
        ? { confirm: { action: confirm.action, workflowId: String(confirm.workflowId) } }
        : {}),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof WorkflowError) return next(mapWorkflowError(err));
    next(err);
  }
});
