import { DealModel } from '../models/deal.model.js';
import { parseListItems } from './crm-list.util.js';

export async function getDeals(userId: string): Promise<Record<string, unknown>[]> {
  const doc = await DealModel.findOne({ userId }).lean();
  return doc?.items ?? [];
}

export async function replaceDeals(
  userId: string,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const items = parseListItems(input);
  const now = new Date().toISOString();
  const saved = await DealModel.findOneAndUpdate(
    { userId },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, createdAt: now } },
    { upsert: true, new: true, lean: true }
  );
  return saved?.items ?? items;
}
