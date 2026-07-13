import { MasterListModel, type MasterListKind } from '../models/master-list.model.js';
import { parseListItems } from './crm-list.util.js';

export async function getMasterList(
  userId: string,
  kind: MasterListKind
): Promise<Record<string, unknown>[]> {
  const doc = await MasterListModel.findOne({ userId, kind }).lean();
  return doc?.items ?? [];
}

export async function replaceMasterList(
  userId: string,
  kind: MasterListKind,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const items = parseListItems(input);
  const now = new Date().toISOString();
  const saved = await MasterListModel.findOneAndUpdate(
    { userId, kind },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, kind, createdAt: now } },
    { upsert: true, returnDocument: 'after', lean: true }
  );
  return saved?.items ?? items;
}
