import { CompanyModel } from '../models/company.model.js';
import { parseListItems } from './crm-list.util.js';

export async function getCompanies(userId: string): Promise<Record<string, unknown>[]> {
  const doc = await CompanyModel.findOne({ userId }).lean();
  return doc?.items ?? [];
}

export async function replaceCompanies(
  userId: string,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const items = parseListItems(input);
  const now = new Date().toISOString();
  const saved = await CompanyModel.findOneAndUpdate(
    { userId },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, createdAt: now } },
    { upsert: true, returnDocument: 'after', lean: true }
  );
  return saved?.items ?? items;
}
