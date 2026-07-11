import { HttpError } from '../http-error.js';
import { MasterListModel, type MasterListKind } from '../models/master-list.model.js';

// Light validation only: array of objects, each with a unique non-empty `id`.
// The rest of each item is stored verbatim (shapes are rich and evolving).
function parseItems(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'items must be an array');
  const seen = new Set<string>();
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new HttpError(400, `items[${index}] must be an object`);
    }
    const rec = item as Record<string, unknown>;
    const id = String(rec.id ?? '').trim();
    if (!id) throw new HttpError(400, `items[${index}].id is required`);
    if (seen.has(id)) throw new HttpError(400, `duplicate id: ${id}`);
    seen.add(id);
    return rec;
  });
}

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
  const items = parseItems(input);
  const now = new Date().toISOString();
  const saved = await MasterListModel.findOneAndUpdate(
    { userId, kind },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, kind, createdAt: now } },
    { upsert: true, new: true, lean: true }
  );
  return saved?.items ?? items;
}
