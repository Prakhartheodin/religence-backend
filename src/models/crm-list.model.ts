import mongoose from 'mongoose';

// Every CRM entity is the same shape: one doc per user, items stored verbatim
// (shapes are rich and evolving). Only the collection name differs.
export type CrmListDoc = {
  userId: string;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

export function crmListModel(name: string, collection: string): mongoose.Model<CrmListDoc> {
  const schema = new mongoose.Schema(
    {
      userId: { type: String, required: true, unique: true },
      items: { type: [mongoose.Schema.Types.Mixed], default: [] },
      createdAt: { type: String, required: true },
      updatedAt: { type: String, required: true },
    },
    { collection }
  );
  return mongoose.models[name] || mongoose.model<CrmListDoc>(name, schema);
}
