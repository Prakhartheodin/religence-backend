import { Router, type Request } from 'express';
import { HttpError } from '../http-error.js';
import { notificationService } from '../services/notification.service.js';
import type { NotificationCategory, NotificationType } from '../models/notification.model.js';

export const notificationsRouter = Router();

function uid(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? '';
}

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const category = req.query.category as NotificationCategory | undefined;
    const limitRaw = req.query.limit;
    const limit =
      limitRaw !== undefined ? Number.parseInt(String(limitRaw), 10) : undefined;
    const result = await notificationService.listForUser(uid(req), {
      category,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({
      items: result.items,
      total: result.total,
      activityTotal: result.activityTotal,
      limit: Math.min(Math.max(limit ?? 50, 1), 100),
    });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/scan', async (req, res, next) => {
  try {
    await notificationService.scanVerificationPending(uid(req));
    res.json({ scanned: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body as {
      type?: NotificationType;
      title?: string;
      body?: string;
      href?: string;
      dedupeKey?: string;
      meta?: Record<string, unknown>;
    };
    if (!body.type || !body.title || !body.body || !body.href) {
      throw new HttpError(400, 'type, title, body, href required');
    }
    let input;
    try {
      input = notificationService.deriveEmitFromClientBody(uid(req), {
        type: body.type,
        title: body.title,
        body: body.body,
        href: body.href,
        dedupeKey: body.dedupeKey,
        meta: body.meta,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid payload';
      throw new HttpError(400, message);
    }
    const item = await notificationService.emit(input);
    if (!item) {
      res.status(204).send();
      return;
    }
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/dedupe/:dedupeKey', async (req, res, next) => {
  try {
    const dedupeKey = decodeURIComponent(req.params.dedupeKey);
    // Idempotent: always 204 — clears dismissal even when notification row missing
    await notificationService.deleteByDedupeKey(uid(req), dedupeKey);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const intentRaw = req.query.intent;
    const intent =
      intentRaw === 'dismiss' ? 'dismiss' : ('navigate' as const);
    const deleted = await notificationService.deleteForUser(
      uid(req),
      req.params.id,
      intent
    );
    if (!deleted) throw new HttpError(404, 'notification not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
