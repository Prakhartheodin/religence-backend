import mongoose from 'mongoose';

export type NotificationCategory = 'action' | 'activity';

export type NotificationType =
  | 'verification_pending'
  | 'follow_up_due'
  | 'inbound_email'
  | 'outlook_error'
  | 'lead_verified'
  | 'stage_changed'
  | 'sample_logged'
  | 'quotation_logged';

export type NotificationMeta = {
  leadId?: string;
  threadId?: string;
  messageId?: string;
  sentAt?: string;
  accountId?: string;
  count?: number;
  actorName?: string;
  previousStage?: string;
  stage?: string;
  quoteNo?: string;
};

export type NotificationDocument = {
  id: string;
  userId: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  icon: string;
  href: string;
  dedupeKey?: string;
  meta?: NotificationMeta;
  createdAt: Date;
  updatedAt: Date;
};

const metaSchema = new mongoose.Schema(
  {
    leadId: { type: String },
    threadId: { type: String },
    messageId: { type: String },
    sentAt: { type: String },
    accountId: { type: String },
    count: { type: Number },
    actorName: { type: String },
    previousStage: { type: String },
    stage: { type: String },
    quoteNo: { type: String },
  },
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    category: { type: String, required: true, enum: ['action', 'activity'] },
    title: { type: String, required: true },
    body: { type: String, required: true },
    icon: { type: String, required: true },
    href: { type: String, required: true },
    dedupeKey: { type: String },
    meta: { type: metaSchema },
  },
  {
    collection: 'notifications',
    versionKey: false,
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret._id;
        delete ret.userId;
        return ret;
      },
    },
  }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } }
);
notificationSchema.index({ userId: 1, id: 1 }, { unique: true });

export const NotificationModel =
  (mongoose.models.Notification as mongoose.Model<NotificationDocument>) ??
  mongoose.model<NotificationDocument>('Notification', notificationSchema);
