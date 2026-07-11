import mongoose from 'mongoose';

// Per-user saved contacts. One document per user; items stored verbatim.
export type ContactListDoc = {
  userId: string;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

const contactSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { collection: 'contacts' }
);

export const ContactModel =
  mongoose.models.Contact || mongoose.model('Contact', contactSchema);
