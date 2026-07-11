import mongoose from 'mongoose';

// Per-user CRM timeline events. One document per user; items stored verbatim.
export type TimelineListDoc = {
  userId: string;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

const timelineSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { collection: 'crm_timeline' }
);

export const TimelineModel =
  mongoose.models.Timeline || mongoose.model('Timeline', timelineSchema);
