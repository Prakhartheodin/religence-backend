import mongoose from 'mongoose';

export type OutlookSyncStateDoc = {
  userId: string;
  accountId: string;
  folderWellKnown: string;
  deltaLink: string | null;
  lastSyncAt: string | null;
  bootstrapComplete: boolean;
  updatedAt: string;
};

const outlookSyncStateSchema = new mongoose.Schema<OutlookSyncStateDoc>(
  {
    userId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    folderWellKnown: { type: String, required: true },
    deltaLink: { type: String, default: null },
    lastSyncAt: { type: String, default: null },
    bootstrapComplete: { type: Boolean, default: false },
    updatedAt: { type: String, required: true },
  },
  {
    collection: 'outlook_sync_state',
    versionKey: false,
  }
);

outlookSyncStateSchema.index(
  { userId: 1, accountId: 1, folderWellKnown: 1 },
  { unique: true }
);

export const OutlookSyncStateModel =
  mongoose.models.OutlookSyncState ||
  mongoose.model<OutlookSyncStateDoc>('OutlookSyncState', outlookSyncStateSchema);
