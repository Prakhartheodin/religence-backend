import { HttpError } from '../http-error.js';
import { BuyerCatalogue } from '../models/buyer.model.js';
import type { BuyerMasterModel } from '../types/master-data.js';

function toBuyerModel(doc: Record<string, unknown>): BuyerMasterModel {
  return {
    id: String(doc.id),
    medicineId: String(doc.medicineId),
    saltId: String(doc.saltId),
    productName: String(doc.productName),
    casNo: doc.casNo == null || doc.casNo === '' ? null : String(doc.casNo),
    buyerName: String(doc.buyerName),
    companyCategory:
      doc.companyCategory == null || doc.companyCategory === ''
        ? null
        : String(doc.companyCategory),
    certifications: Array.isArray(doc.certifications)
      ? doc.certifications.map((v) => String(v))
      : [],
    annualBuyingCapacityKg:
      typeof doc.annualBuyingCapacityKg === 'number' && Number.isFinite(doc.annualBuyingCapacityKg)
        ? doc.annualBuyingCapacityKg
        : null,
    contactPersons: Array.isArray(doc.contactPersons)
      ? doc.contactPersons.map((v) => String(v))
      : [],
    designations: Array.isArray(doc.designations)
      ? doc.designations.map((v) => String(v))
      : [],
    emails: Array.isArray(doc.emails) ? doc.emails.map((v) => String(v)) : [],
    phoneNumbers: Array.isArray(doc.phoneNumbers)
      ? doc.phoneNumbers.map((v) => String(v))
      : [],
    country: doc.country == null || doc.country === '' ? null : String(doc.country),
    sourceFile: String(doc.sourceFile),
    sourceRow: Number(doc.sourceRow),
  };
}

export async function listBuyers(): Promise<BuyerMasterModel[]> {
  const docs = await BuyerCatalogue.find({}).sort({ productName: 1, buyerName: 1 });
  return docs.map((d) => toBuyerModel(d.toJSON() as Record<string, unknown>));
}

export async function countBuyers(): Promise<number> {
  return BuyerCatalogue.countDocuments();
}

/**
 * Additive upsert for UI imports: upserts the given buyers by id but — unlike
 * upsertBuyers — does NOT delete anything else, so importing one molecule's file
 * leaves every other molecule's buyers in place. Re-importing the same file
 * updates in place (buyer ids are a deterministic hash of the row).
 */
export async function mergeUpsertBuyers(
  buyers: BuyerMasterModel[]
): Promise<{ upserted: number; matched: number }> {
  if (!buyers.length) throw new HttpError(400, 'No buyers to import');
  const ops = buyers.map((buyer) => ({
    updateOne: {
      filter: { id: buyer.id },
      update: { $set: buyer as unknown as Record<string, unknown> },
      upsert: true,
    },
  }));
  const result = await BuyerCatalogue.bulkWrite(ops, { ordered: false });
  return { upserted: result.upsertedCount, matched: result.matchedCount };
}

export async function upsertBuyers(
  buyers: BuyerMasterModel[]
): Promise<{ upserted: number; matched: number; removed: number }> {
  if (!buyers.length) {
    throw new HttpError(400, 'No buyers to upsert');
  }

  const ops = buyers.map((buyer) => ({
    updateOne: {
      filter: { id: buyer.id },
      update: { $set: buyer as unknown as Record<string, unknown> },
      upsert: true,
    },
  }));

  const result = await BuyerCatalogue.bulkWrite(ops, { ordered: false });
  const keepIds = buyers.map((b) => b.id);
  const removed = await BuyerCatalogue.deleteMany({ id: { $nin: keepIds } });

  return {
    upserted: result.upsertedCount,
    matched: result.matchedCount,
    removed: removed.deletedCount ?? 0,
  };
}
