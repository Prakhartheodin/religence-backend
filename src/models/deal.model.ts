import mongoose from 'mongoose';

// Per-user deals. One document per user; items stored verbatim.
export type DealListDoc = {
  userId: string;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

const dealSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { collection: 'deals' }
);

export const DealModel =
  mongoose.models.Deal || mongoose.model('Deal', dealSchema);
