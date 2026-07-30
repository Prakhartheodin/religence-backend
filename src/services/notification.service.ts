import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { CrmEntities } from '../models/crm-entities.js';
import {
  NotificationDismissalModel,
  type NotificationDismissalDocument,
} from '../models/notification-dismissal.model.js';
import {
  NotificationModel,
  type NotificationCategory,
  type NotificationDocument,
  type NotificationMeta,
  type NotificationType,
} from '../models/notification.model.js';

export type EmitInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  href: string;
  icon: string;
  dedupeKey?: string;
  meta?: NotificationMeta;
};

type DeleteIntent = 'dismiss' | 'navigate';

const CLIENT_ALLOWED_TYPES = new Set<NotificationType>(['inbound_email', 'outlook_error']);

const NOTIFICATION_TYPE_CONFIG: Record<
  NotificationType,
  { category: NotificationCategory; icon: string }
> = {
  verification_pending: { category: 'action', icon: 'user-check' },
  follow_up_due: { category: 'action', icon: 'calendar-event' },
  follow_up_logged: { category: 'activity', icon: 'calendar-plus' },
  inbound_email: { category: 'action', icon: 'mail' },
  outlook_error: { category: 'action', icon: 'alert-circle' },
  lead_verified: { category: 'activity', icon: 'circle-check' },
  stage_changed: { category: 'activity', icon: 'flag' },
  sample_logged: { category: 'activity', icon: 'package' },
  quotation_logged: { category: 'activity', icon: 'file-invoice' },
};

async function getDismissal(
  userId: string,
  dedupeKey: string
): Promise<NotificationDismissalDocument | null> {
  const doc = await NotificationDismissalModel.findOne({ userId, dedupeKey });
  return doc ? (doc.toJSON() as NotificationDismissalDocument) : null;
}

async function emit(input: EmitInput): Promise<NotificationDocument | null> {
  const config = NOTIFICATION_TYPE_CONFIG[input.type];
  const now = new Date();
  const category = config.category;
  const icon = input.icon || config.icon;

  if (input.dedupeKey) {
    const existing = await NotificationModel.findOne({
      userId: input.userId,
      dedupeKey: input.dedupeKey,
    });
    if (existing) {
      // Inbound upsert with new message → clear dismissal so user sees it again
      if (input.type === 'inbound_email') {
        const prevMsg = existing.meta?.messageId;
        const prevSent = existing.meta?.sentAt;
        const nextMsg = input.meta?.messageId;
        const nextSent = input.meta?.sentAt;
        if (prevMsg !== nextMsg || prevSent !== nextSent) {
          await clearDismissal(input.userId, input.dedupeKey);
        }
      }
      existing.type = input.type;
      existing.category = category;
      existing.title = input.title;
      existing.body = input.body;
      existing.href = input.href;
      existing.icon = icon;
      existing.meta = input.meta;
      existing.updatedAt = now;
      await existing.save();
      return existing.toJSON() as NotificationDocument;
    }

    // Create path: gate client dedupe types against dismissals (mirrors scan skip)
    if (
      input.type === 'outlook_error' ||
      input.type === 'inbound_email'
    ) {
      const dismissal = await getDismissal(input.userId, input.dedupeKey);
      if (shouldSkipClientEmitCreate(input.type, dismissal, input.meta)) {
        return null;
      }
      // New message after dismiss → clear stale dismissal before create
      if (input.type === 'inbound_email' && dismissal) {
        await clearDismissal(input.userId, input.dedupeKey);
      }
    }
  }

  const created = await NotificationModel.create({
    id: `ntf-${randomUUID()}`,
    userId: input.userId,
    type: input.type,
    category,
    title: input.title,
    body: input.body,
    href: input.href,
    icon,
    dedupeKey: input.dedupeKey,
    meta: input.meta,
    createdAt: now,
    updatedAt: now,
  });
  return created.toJSON() as NotificationDocument;
}

async function clearByDedupeKey(userId: string, dedupeKey: string): Promise<void> {
  await NotificationModel.deleteOne({ userId, dedupeKey });
}

async function listForUser(
  userId: string,
  opts?: { category?: NotificationCategory; limit?: number }
): Promise<{ items: NotificationDocument[]; total: number; activityTotal: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);

  const [total, activityTotal] = await Promise.all([
    NotificationModel.countDocuments({ userId }),
    NotificationModel.countDocuments({ userId, category: 'activity' }),
  ]);

  // Category filter: simple query + limit is fine
  if (opts?.category) {
    const docs = await NotificationModel.find({ userId, category: opts.category })
      .sort({ createdAt: -1 })
      .limit(limit);
    return { items: docs.map((doc) => doc.toJSON() as NotificationDocument), total, activityTotal };
  }

  // No category filter: fetch both buckets, merge-sort action-first, THEN cap
  const [actionDocs, activityDocs] = await Promise.all([
    NotificationModel.find({ userId, category: 'action' })
      .sort({ createdAt: -1 })
      .limit(limit),
    NotificationModel.find({ userId, category: 'activity' })
      .sort({ createdAt: -1 })
      .limit(limit),
  ]);

  const items = [...actionDocs.map((doc) => doc.toJSON() as NotificationDocument), ...activityDocs.map((doc) => doc.toJSON() as NotificationDocument)]
    .sort((a, b) => {
      const catOrder = (c: NotificationCategory) => (c === 'action' ? 0 : 1);
      const byCat = catOrder(a.category) - catOrder(b.category);
      if (byCat !== 0) return byCat;
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, limit);

  return { items, total, activityTotal };
}

async function deleteForUser(
  userId: string,
  id: string,
  intent: DeleteIntent = 'navigate'
): Promise<boolean> {
  const doc = await NotificationModel.findOne({ userId, id });
  if (!doc) return false;

  const dedupeKey = doc.dedupeKey;
  const category = doc.category as NotificationCategory;

  // Record/clear dismissal BEFORE deleting row — prevents delete+scan race
  if (dedupeKey) {
    if (category === 'action' && (intent === 'dismiss' || intent === 'navigate')) {
      // ponytail: navigate on deduped action types = ack + delete (same as X dismiss)
      const dismissedCount =
        doc.type === 'verification_pending' ? doc.meta?.count : undefined;
      const dismissedMessageId =
        doc.type === 'inbound_email' ? (doc.meta?.messageId ?? null) : undefined;
      const dismissedSentAt =
        doc.type === 'inbound_email' ? (doc.meta?.sentAt ?? null) : undefined;
      await recordDismissal(userId, dedupeKey, {
        dismissedCount,
        dismissedMessageId,
        dismissedSentAt,
      });
    } else if (intent === 'navigate') {
      await clearDismissal(userId, dedupeKey);
    }
  }

  await NotificationModel.deleteOne({ userId, id });
  return true;
}

async function deleteByDedupeKey(userId: string, dedupeKey: string): Promise<boolean> {
  const res = await NotificationModel.deleteOne({ userId, dedupeKey });
  await clearDismissal(userId, dedupeKey);
  return res.deletedCount > 0;
}

async function recordDismissal(
  userId: string,
  dedupeKey: string,
  opts?: {
    dismissedCount?: number;
    dismissedMessageId?: string | null;
    dismissedSentAt?: string | null;
  }
): Promise<void> {
  await NotificationDismissalModel.findOneAndUpdate(
    { userId, dedupeKey },
    {
      userId,
      dedupeKey,
      dismissedAt: new Date(),
      ...(opts?.dismissedCount !== undefined
        ? { dismissedCount: opts.dismissedCount }
        : {}),
      ...(opts?.dismissedMessageId !== undefined
        ? { dismissedMessageId: opts.dismissedMessageId }
        : {}),
      ...(opts?.dismissedSentAt !== undefined
        ? { dismissedSentAt: opts.dismissedSentAt }
        : {}),
    },
    { upsert: true, new: true }
  );
}

async function clearDismissal(userId: string, dedupeKey: string): Promise<void> {
  await NotificationDismissalModel.deleteOne({ userId, dedupeKey });
}

/** Pure: should scan skip emit because dismissal still covers current count? */
function shouldSkipVerificationEmit(
  count: number,
  dismissedCount: number | undefined
): boolean {
  return dismissedCount !== undefined && count <= dismissedCount;
}

/** Pure: should client POST skip create because dismissal still covers unchanged condition? */
function shouldSkipClientEmitCreate(
  type: NotificationType,
  dismissal: NotificationDismissalDocument | null,
  meta?: NotificationMeta
): boolean {
  if (!dismissal) return false;
  if (type === 'outlook_error') return true;
  if (type === 'inbound_email') {
    const msg = meta?.messageId ?? null;
    const sent = meta?.sentAt ?? null;
    const dismissedMsg = dismissal.dismissedMessageId ?? null;
    const dismissedSent = dismissal.dismissedSentAt ?? null;
    return msg === dismissedMsg && sent === dismissedSent;
  }
  return false;
}

async function scanVerificationPending(userId: string): Promise<void> {
  const dedupeKey = 'verification_pending';
  const LeadModel = CrmEntities.leads;
  const savedLeads = await LeadModel.find({ userId, stage: 'Saved' });
  const count = savedLeads.length;

  if (count === 0) {
    await clearByDedupeKey(userId, dedupeKey);
    return;
  }

  const dismissal = await getDismissal(userId, dedupeKey);
  if (dismissal && shouldSkipVerificationEmit(count, dismissal.dismissedCount)) {
    return;
  }

  await emit({
    userId,
    type: 'verification_pending',
    title: `${count} leads awaiting verification`,
    body: 'Saved-stage leads need approval before outreach.',
    href: '/verification-queue',
    icon: 'user-check',
    dedupeKey,
    meta: { count },
  });
}

function assertClientEmitAllowed(type: NotificationType): void {
  if (!CLIENT_ALLOWED_TYPES.has(type)) {
    throw new Error(`Client emit not allowed for type: ${type}`);
  }
}

function deriveEmitFromClientBody(
  userId: string,
  body: {
    type: NotificationType;
    title: string;
    body: string;
    href: string;
    dedupeKey?: string;
    meta?: NotificationMeta;
  }
): EmitInput {
  assertClientEmitAllowed(body.type);
  if (!body.title || !body.body || !body.href.startsWith('/')) {
    throw new Error('Invalid emit payload');
  }
  if (!body.dedupeKey) {
    throw new Error('dedupeKey required for client emit types');
  }
  const config = NOTIFICATION_TYPE_CONFIG[body.type];
  return {
    userId,
    type: body.type,
    title: body.title,
    body: body.body,
    href: body.href,
    icon: config.icon,
    dedupeKey: body.dedupeKey,
    meta: body.meta,
  };
}

export const notificationService = {
  emit,
  listForUser,
  deleteForUser,
  deleteByDedupeKey,
  scanVerificationPending,
  deriveEmitFromClientBody,
};

// ponytail: assert self-check — run with `npx tsx src/services/notification.service.ts`
if (process.argv[1]?.endsWith('notification.service.ts')) {
  assert.equal(NOTIFICATION_TYPE_CONFIG.verification_pending.category, 'action');
  assert.equal(NOTIFICATION_TYPE_CONFIG.verification_pending.icon, 'user-check');
  assert.equal(NOTIFICATION_TYPE_CONFIG.sample_logged.category, 'activity');
  assert.equal(NOTIFICATION_TYPE_CONFIG.quotation_logged.category, 'activity');
  assert.equal(NOTIFICATION_TYPE_CONFIG.follow_up_logged.category, 'activity');

  // scan dismissal math
  assert.equal(shouldSkipVerificationEmit(3, 3), true);
  assert.equal(shouldSkipVerificationEmit(2, 3), true);
  assert.equal(shouldSkipVerificationEmit(4, 3), false);
  assert.equal(shouldSkipVerificationEmit(1, undefined), false);

  // client emit create dismissal gate
  assert.equal(
    shouldSkipClientEmitCreate('outlook_error', { userId: 'u', dedupeKey: 'k', dismissedAt: new Date() }, undefined),
    true
  );
  assert.equal(
    shouldSkipClientEmitCreate(
      'inbound_email',
      {
        userId: 'u',
        dedupeKey: 'k',
        dismissedAt: new Date(),
        dismissedMessageId: 'msg-1',
        dismissedSentAt: '2026-07-29T10:00:00Z',
      },
      { messageId: 'msg-1', sentAt: '2026-07-29T10:00:00Z' }
    ),
    true
  );
  assert.equal(
    shouldSkipClientEmitCreate(
      'inbound_email',
      {
        userId: 'u',
        dedupeKey: 'k',
        dismissedAt: new Date(),
        dismissedMessageId: 'msg-1',
        dismissedSentAt: '2026-07-29T10:00:00Z',
      },
      { messageId: 'msg-2', sentAt: '2026-07-29T10:05:00Z' }
    ),
    false
  );

  // deriveEmitFromClientBody
  const inbound = deriveEmitFromClientBody('usr-1', {
    type: 'inbound_email',
    title: 'New email',
    body: 'From alice@example.com',
    href: '/inbox?email=outlook-thread-1',
    dedupeKey: 'inbound_email:thread-1',
    meta: { threadId: 'thread-1', messageId: 'msg-1', sentAt: '2026-07-29T10:00:00Z' },
  });
  assert.equal(inbound.type, 'inbound_email');
  assert.equal(inbound.icon, 'mail');
  assert.equal(inbound.dedupeKey, 'inbound_email:thread-1');

  assert.throws(() => deriveEmitFromClientBody('usr-1', {
    type: 'lead_verified',
    title: 'x',
    body: 'y',
    href: '/active-leads/1',
    dedupeKey: 'k',
  }));
  assert.throws(() => deriveEmitFromClientBody('usr-1', {
    type: 'inbound_email',
    title: 'x',
    body: 'y',
    href: 'https://evil.com',
    dedupeKey: 'k',
  }));
  assert.throws(() => deriveEmitFromClientBody('usr-1', {
    type: 'inbound_email',
    title: 'x',
    body: 'y',
    href: '/inbox',
  }));

  console.log('notification.service self-check passed');
}
