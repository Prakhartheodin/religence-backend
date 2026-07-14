import { Router, type Request, type Response } from 'express';
import config from '../config.js';
import { HttpError } from '../http-error.js';
import { buildFrontendUrl } from '../lib/normalize-url.js';
import { requireAuth } from '../middleware/require-auth.js';
import { verifyOutlookConnectToken } from '../services/auth.service.js';
import {
  batchModifyThreads,
  disconnectOutlookAccount,
  forwardMessage,
  getAttachment,
  getMessage,
  getMicrosoftAuthUrl,
  getThread,
  handleMicrosoftCallback,
  listLabels,
  listOutlookAccounts,
  listThreads,
  modifyMessage,
  replyAllMessage,
  replyMessage,
  sendMessage,
  trashThreads,
} from '../services/outlook.service.js';
import {
  listEmailTemplates,
  replaceEmailTemplates,
} from '../services/email-templates.service.js';

export const emailRouter = Router();

emailRouter.use(requireAuth);

function requireUserId(req: Request): string {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) throw new HttpError(401, 'authentication required');
  return userId;
}

function asString(value: unknown, field: string): string {
  const v = String(value || '').trim();
  if (!v) throw new HttpError(400, `${field} is required`);
  return v;
}

function optionalString(value: unknown): string | undefined {
  const v = String(value || '').trim();
  return v || undefined;
}

emailRouter.get('/auth/microsoft/start', async (req, res, next) => {
  try {
    const connectToken = String(req.query.connectToken ?? '').trim();
    if (!connectToken) throw new HttpError(401, 'connect token required');
    const userId = verifyOutlookConnectToken(connectToken);
    const url = await getMicrosoftAuthUrl(userId);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/auth/microsoft', async (req, res, next) => {
  try {
    const url = await getMicrosoftAuthUrl(requireUserId(req));
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/auth/microsoft/callback', async (req, res, next) => {
  try {
    const code = asString(req.query.code, 'code');
    const state = asString(req.query.state, 'state');
    const account = await handleMicrosoftCallback(code, state);
    // Trailing slash matters: the frontend runs with trailingSlash:true, so
    // /inbox redirects to /inbox/ and drops the query string on the way —
    // taking outlook_connected with it, which left the new account unselected.
    res.redirect(
      buildFrontendUrl(config.appBaseUrl, '/inbox/', {
        outlook_connected: account.email,
      })
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return res.redirect(
        buildFrontendUrl(config.appBaseUrl, '/inbox/', {
          outlook_error: err.message,
        })
      );
    }
    next(err);
  }
});

emailRouter.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await listOutlookAccounts(requireUserId(req));
    res.json(accounts);
  } catch (err) {
    next(err);
  }
});

emailRouter.delete('/accounts/:id', async (req, res, next) => {
  try {
    await disconnectOutlookAccount(requireUserId(req), asString(req.params.id, 'id'));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/templates', async (req, res, next) => {
  try {
    const templates = await listEmailTemplates(requireUserId(req));
    res.json(templates);
  } catch (err) {
    next(err);
  }
});

emailRouter.put('/templates', async (req, res, next) => {
  try {
    const rawTemplates = Array.isArray(req.body)
      ? req.body
      : req.body?.templates;
    const templates = await replaceEmailTemplates(requireUserId(req), rawTemplates);
    res.json(templates);
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/labels', async (req, res, next) => {
  try {
    const labels = await listLabels(
      requireUserId(req),
      asString(req.query.accountId, 'accountId')
    );
    res.json(labels);
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/threads', async (req, res, next) => {
  try {
    const result = await listThreads(requireUserId(req), asString(req.query.accountId, 'accountId'), {
      labelId: optionalString(req.query.labelId),
      pageToken: optionalString(req.query.pageToken),
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      query: optionalString(req.query.q),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/threads/:id', async (req, res, next) => {
  try {
    const thread = await getThread(
      requireUserId(req),
      asString(req.query.accountId, 'accountId'),
      asString(req.params.id, 'id')
    );
    res.json(thread);
  } catch (err) {
    next(err);
  }
});

emailRouter.get('/messages/:id', async (req, res, next) => {
  try {
    const message = await getMessage(
      requireUserId(req),
      asString(req.query.accountId, 'accountId'),
      asString(req.params.id, 'id')
    );
    res.json(message);
  } catch (err) {
    next(err);
  }
});

emailRouter.get(
  '/messages/:messageId/attachments/:attachmentId',
  async (req: Request, res: Response, next) => {
    try {
      const base64 = await getAttachment(
        requireUserId(req),
        asString(req.query.accountId, 'accountId'),
        asString(req.params.messageId, 'messageId'),
        asString(req.params.attachmentId, 'attachmentId')
      );
      const buf = Buffer.from(base64, 'base64');
      res.set('Content-Disposition', 'attachment');
      res.send(buf);
    } catch (err) {
      next(err);
    }
  }
);

emailRouter.post('/messages/send', async (req, res, next) => {
  try {
    const result = await sendMessage(requireUserId(req), asString(req.body.accountId, 'accountId'), {
      to: req.body.to,
      cc: req.body.cc,
      bcc: req.body.bcc,
      subject: req.body.subject,
      html: req.body.html,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.post('/messages/:id/reply', async (req, res, next) => {
  try {
    const result = await replyMessage(
      requireUserId(req),
      asString(req.body.accountId, 'accountId'),
      asString(req.params.id, 'id'),
      {
        html: req.body.html,
      }
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.post('/messages/:id/reply-all', async (req, res, next) => {
  try {
    const result = await replyAllMessage(
      requireUserId(req),
      asString(req.body.accountId, 'accountId'),
      asString(req.params.id, 'id'),
      {
        html: req.body.html,
      }
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.post('/messages/:id/forward', async (req, res, next) => {
  try {
    const result = await forwardMessage(
      requireUserId(req),
      asString(req.body.accountId, 'accountId'),
      asString(req.params.id, 'id'),
      {
        to: req.body.to,
        html: req.body.html,
      }
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.patch('/messages/:id', async (req, res, next) => {
  try {
    const result = await modifyMessage(
      requireUserId(req),
      asString(req.query.accountId, 'accountId'),
      asString(req.params.id, 'id'),
      {
        addLabelIds: Array.isArray(req.body?.addLabelIds) ? req.body.addLabelIds : [],
        removeLabelIds: Array.isArray(req.body?.removeLabelIds) ? req.body.removeLabelIds : [],
      }
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.post('/threads/batch-modify', async (req, res, next) => {
  try {
    const result = await batchModifyThreads(
      requireUserId(req),
      asString(req.body.accountId, 'accountId'),
      Array.isArray(req.body.threadIds) ? req.body.threadIds : [],
      {
        addLabelIds: Array.isArray(req.body.addLabelIds) ? req.body.addLabelIds : [],
        removeLabelIds: Array.isArray(req.body.removeLabelIds) ? req.body.removeLabelIds : [],
      }
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.post('/threads/trash', async (req, res, next) => {
  try {
    const result = await trashThreads(
      requireUserId(req),
      asString(req.body.accountId, 'accountId'),
      Array.isArray(req.body.threadIds) ? req.body.threadIds : []
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
