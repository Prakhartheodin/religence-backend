import mongoose from 'mongoose';

/**
 * The salt/medicine catalogue is SHARED — one row per salt, not one per user.
 *
 * These used to run through crmList(), the generic per-user list service, which
 * gave every user a private copy of the same 10 Excel-derived rows. Nothing ever
 * read the owner (the API stripped `userId` before it reached the client) and
 * leads reference salts by NAME, not id — so there was never a reason for it.
 *
 * Deliberately NOT built with entityModel(): that helper hardcodes a required
 * `userId` and a {userId, id} unique index, which is the bug.
 *
 * ids are the deterministic slugs minted by master-data.service.ts
 * (`salt-budesonide`, `med-budesonide`). The Excel buyer rows join on them, so
 * they must not change.
 */

const strip = (_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> => {
  delete ret._id;
  return ret;
};

const saltSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
  },
  { collection: 'salts', versionKey: false, toJSON: { transform: strip } }
);
saltSchema.index({ id: 1 }, { unique: true, name: 'id_1' });

const medicineSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    saltId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    dosageForm: { type: String, default: 'API', trim: true },
  },
  { collection: 'medicines', versionKey: false, toJSON: { transform: strip } }
);
medicineSchema.index({ id: 1 }, { unique: true, name: 'id_1' });

export const SaltCatalogue =
  (mongoose.models.Salt as mongoose.Model<Record<string, unknown>>) ??
  mongoose.model<Record<string, unknown>>('Salt', saltSchema);

export const MedicineCatalogue =
  (mongoose.models.Medicine as mongoose.Model<Record<string, unknown>>) ??
  mongoose.model<Record<string, unknown>>('Medicine', medicineSchema);
