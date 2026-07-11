import mongoose from 'mongoose';

// Per-user saved companies. One document per user; items stored verbatim.
export type CompanyListDoc = {
  userId: string;
  items: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
};

const companySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { collection: 'companies' }
);

export const CompanyModel =
  mongoose.models.Company || mongoose.model('Company', companySchema);
