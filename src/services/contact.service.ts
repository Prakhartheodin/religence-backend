import { ContactModel } from '../models/contact.model.js';
import { parseListItems } from './crm-list.util.js';

export async function getContacts(userId: string): Promise<Record<string, unknown>[]> {
  const doc = await ContactModel.findOne({ userId }).lean();
  return doc?.items ?? [];
}

export async function replaceContacts(
  userId: string,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const items = parseListItems(input);
  const now = new Date().toISOString();
  const saved = await ContactModel.findOneAndUpdate(
    { userId },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, createdAt: now } },
    { upsert: true, new: true, lean: true }
  );
  return saved?.items ?? items;
}
