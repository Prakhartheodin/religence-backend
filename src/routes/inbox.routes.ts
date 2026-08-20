import { Router, type Request } from 'express';
import { HttpError } from '../http-error.js';
import { inboxPreflight } from '../services/mail-workflow/workflow.service.js';

export const inboxRouter = Router();

function requireUserId(req: Request): string {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) throw new HttpError(401, 'authentication required');
  return userId;
}

inboxRouter.get('/preflight', async (req, res, next) => {
  try {
    const result = await inboxPreflight(requireUserId(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});
