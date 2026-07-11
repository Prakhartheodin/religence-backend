import mongoose from 'mongoose';

export type MasterListKind = 'salts' | 'medicines';

export type MasterListDoc = {
  userId: string;
  kind: MasterListKind;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

const masterListSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    kind: { type: String, required: true, enum: ['salts', 'medicines'] },
    // Salt/medicine shapes are rich and evolving — store as-is.
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { collection: 'master_lists' }
);

masterListSchema.index({ userId: 1, kind: 1 }, { unique: true });

export const MasterListModel =
  mongoose.models.MasterList || mongoose.model('MasterList', masterListSchema);
