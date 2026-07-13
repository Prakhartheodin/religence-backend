import mongoose from 'mongoose';

/**
 * Shared buyer catalogue — one row per buyer, not per user.
 *
 * ids are deterministic hashes minted by excel-master-data.ts
 * (`buyer-<sha1>`). Lead Discovery joins on saltId/medicineId, so those
 * slugs must stay stable across re-seeds.
 */

const strip = (_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> => {
  delete ret._id;
  return ret;
};

const buyerSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    medicineId: { type: String, required: true, trim: true },
    saltId: { type: String, required: true, trim: true },
    productName: { type: String, required: true, trim: true },
    casNo: { type: String, default: null, trim: true },
    buyerName: { type: String, required: true, trim: true },
    companyCategory: { type: String, default: null, trim: true },
    certifications: { type: [String], default: [] },
    annualBuyingCapacityKg: { type: Number, default: null },
    contactPersons: { type: [String], default: [] },
    designations: { type: [String], default: [] },
    emails: { type: [String], default: [] },
    phoneNumbers: { type: [String], default: [] },
    country: { type: String, default: null, trim: true },
    sourceFile: { type: String, required: true, trim: true },
    sourceRow: { type: Number, required: true },
  },
  { collection: 'buyers', versionKey: false, toJSON: { transform: strip } }
);
buyerSchema.index({ id: 1 }, { unique: true, name: 'id_1' });
buyerSchema.index({ saltId: 1 }, { name: 'saltId_1' });
buyerSchema.index({ medicineId: 1 }, { name: 'medicineId_1' });
buyerSchema.index({ productName: 1 }, { name: 'productName_1' });

export const BuyerCatalogue =
  (mongoose.models.Buyer as mongoose.Model<Record<string, unknown>>) ??
  mongoose.model<Record<string, unknown>>('Buyer', buyerSchema);
