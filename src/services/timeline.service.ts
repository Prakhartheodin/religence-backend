import { TimelineModel } from '../models/timeline.model.js';
import { parseListItems } from './crm-list.util.js';

export async function getTimeline(userId: string): Promise<Record<string, unknown>[]> {
  const doc = await TimelineModel.findOne({ userId }).lean();
  return doc?.items ?? [];
}

export async function replaceTimeline(
  userId: string,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const items = parseListItems(input);
  const now = new Date().toISOString();
  const saved = await TimelineModel.findOneAndUpdate(
    { userId },
    { $set: { items, updatedAt: now }, $setOnInsert: { userId, createdAt: now } },
    { upsert: true, returnDocument: 'after', lean: true }
  );
  return saved?.items ?? items;
}
