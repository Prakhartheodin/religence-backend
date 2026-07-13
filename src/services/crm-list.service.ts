import { crmListModel } from '../models/crm-list.model.js';
import { parseListItems } from './crm-list.util.js';

export type CrmListService = {
  get: (userId: string) => Promise<Record<string, unknown>[]>;
  replace: (userId: string, input: unknown) => Promise<Record<string, unknown>[]>;
};

/** One doc per user, whole list replaced on write. Same for every CRM entity. */
export function crmList(name: string, collection: string): CrmListService {
  const Model = crmListModel(name, collection);
  return {
    async get(userId) {
      const doc = await Model.findOne({ userId }).lean();
      return doc?.items ?? [];
    },
    async replace(userId, input) {
      const items = parseListItems(input);
      const now = new Date().toISOString();
      const saved = await Model.findOneAndUpdate(
        { userId },
        { $set: { items, updatedAt: now }, $setOnInsert: { userId, createdAt: now } },
        { upsert: true, returnDocument: 'after', lean: true }
      );
      return saved?.items ?? items;
    },
  };
}
