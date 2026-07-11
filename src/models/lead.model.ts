import mongoose from 'mongoose';

// Per-user pipeline leads. One document per user; items stored verbatim.
export type LeadListDoc = {
  userId: string;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

const leadSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { collection: 'leads' }
);

export const LeadModel =
  mongoose.models.Lead || mongoose.model('Lead', leadSchema);
