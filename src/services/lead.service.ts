import { LeadModel } from '../models/lead.model.js';
import { parseListItems } from './crm-list.util.js';

export async function getLeads(userId: string): Promise<Record<string, unknown>[]> {
  const doc = await LeadModel.findOne({ userId }).lean();
  return doc?.items ?? [];
}

export async function replaceLeads(
  userId: string,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const items = parseListItems(input);
  const now = new Date().toISOString();
  const saved = await LeadModel.findOneAndUpdate(
    { userId },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, createdAt: now } },
    { upsert: true, new: true, lean: true }
  );
  return saved?.items ?? items;
}
