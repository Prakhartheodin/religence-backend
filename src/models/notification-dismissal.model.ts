import mongoose from 'mongoose';

export type NotificationDismissalDocument = {
  userId: string;
  dedupeKey: string;
  dismissedAt: Date;
  dismissedCount?: number;
  dismissedMessageId?: string | null;
  dismissedSentAt?: string | null;
};

const dismissalSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    dedupeKey: { type: String, required: true },
    dismissedAt: { type: Date, required: true },
    dismissedCount: { type: Number },
    dismissedMessageId: { type: String },
    dismissedSentAt: { type: String },
  },
  {
    collection: 'notification_dismissals',
    versionKey: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret._id;
        delete ret.userId;
        return ret;
      },
    },
  }
);

dismissalSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true });

export const NotificationDismissalModel =
  (mongoose.models.NotificationDismissal as mongoose.Model<NotificationDismissalDocument>) ??
  mongoose.model<NotificationDismissalDocument>('NotificationDismissal', dismissalSchema);
