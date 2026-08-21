import { Router, type Request } from 'express';
import { HttpError } from '../http-error.js';
import { WorkflowError } from '../services/mail-workflow/contract.js';
import {
  handleChatMessage,
  clearConversationDraft,
  confirmPendingChat,
} from '../services/mail-workflow/chat-parser.js';
import {
  getMailChatSession,
  getOrCreateMailSession,
  findCachedResponse,
  persistChatExchange,
  recordSessionUpdate,
} from '../services/mail-workflow/chat-session.service.js';

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

chatRouter.get('/session', async (req, res, next) => {
  try {
    const session = await getMailChatSession(requireUserId(req));
    res.json(session);
  } catch (err) {
    next(err);
  }
});

chatRouter.post('/message', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const choiceId = req.body?.choiceId ? String(req.body.choiceId).trim() : undefined;
    const textRaw = String(req.body?.text ?? '').trim();
    if (!textRaw && !choiceId && !req.body?.confirm?.workflowId) {
      throw new HttpError(400, 'text is required');
    }
    const text = textRaw || '(choice)';
    const requestId = asString(req.body?.requestId, 'requestId');
    const confirm = req.body?.confirm;
    const input = {
      text,
      requestId,
      ...(choiceId ? { choiceId } : {}),
      ...(confirm?.workflowId && confirm?.action
        ? { confirm: { action: confirm.action, workflowId: String(confirm.workflowId) } }
        : {}),
    };

    const result = findCachedResponse(await getOrCreateMailSession(userId), requestId)
      ?? (await handleChatMessage(userId, input));
    const exchange = await persistChatExchange(userId, input, result);
    res.json({ result, exchange });
  } catch (err) {
    if (err instanceof WorkflowError) return next(mapWorkflowError(err));
    next(err);
  }
});

chatRouter.post('/session/record', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const requestId = asString(req.body?.requestId, 'requestId');
    const removeMessageIds = Array.isArray(req.body?.removeMessageIds)
      ? req.body.removeMessageIds.map((id: unknown) => String(id))
      : undefined;
    const assistantResponse = req.body?.assistantResponse;
    const systemText = req.body?.systemText ? String(req.body.systemText) : undefined;
    const clearDraft = Boolean(req.body?.clearDraft);
    const session = await recordSessionUpdate(userId, {
      requestId,
      ...(removeMessageIds?.length ? { removeMessageIds } : {}),
      ...(assistantResponse ? { assistantResponse } : {}),
      ...(systemText ? { systemText } : {}),
      ...(clearDraft ? { clearDraft } : {}),
    });
    res.json(session);
  } catch (err) {
    next(err);
  }
});

/**
 * Canonical confirmation endpoint. The preview card's Confirm button posts here so that
 * it takes exactly the same path as a natural-language "yes" — one confirmation flow,
 * idempotent via the draft's stored requestId.
 */
chatRouter.post('/confirm', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const requestId = asString(req.body?.requestId, 'requestId');
    // Identifies WHICH preview card was clicked. Absent for a typed "yes", which always
    // means the current draft.
    const confirmToken = req.body?.confirmToken
      ? String(req.body.confirmToken).trim()
      : undefined;
    // Same ledger short-circuit /message has: a second click on the same card replays the
    // first answer instead of reporting "nothing waiting" after a successful send.
    const result =
      findCachedResponse(await getOrCreateMailSession(userId), requestId)
      ?? (await confirmPendingChat(userId, requestId, confirmToken ? { confirmToken } : undefined));
    const exchange = await persistChatExchange(
      userId,
      { text: '(confirm)', requestId, confirm: { action: 'schedule' } },
      result,
    );
    res.json({ result, exchange });
  } catch (err) {
    if (err instanceof WorkflowError) return next(mapWorkflowError(err));
    next(err);
  }
});

chatRouter.post('/clear', async (req, res, next) => {
  try {
    await clearConversationDraft(requireUserId(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
