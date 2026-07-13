import { HttpError } from '../http-error.js';
import { CrmEntities, type CrmEntityName } from '../models/crm-entities.js';
import { parseListItems } from './crm-list.util.js';

export type CrmListService = {
  get: (userId: string) => Promise<Record<string, unknown>[]>;
  replace: (userId: string, input: unknown) => Promise<Record<string, unknown>[]>;
};

/**
 * Storage is normalised (one document per item) but the API stays whole-array:
 * the client PUTs the full list and we diff it. Upsert everything sent, delete
 * anything that's gone. One bulkWrite, so it's a single round trip.
 */
export function crmList(entity: CrmEntityName): CrmListService {
  const Model = CrmEntities[entity];
  return {
    async get(userId) {
      const docs = await Model.find({ userId }).sort({ _order: 1 });
      return docs.map((d) => d.toJSON());
    },

    async replace(userId, input) {
      const items = parseListItems(input);
      const ids = items.map((i) => String(i.id));

      // Hydrating each item casts it against the schema ("2026-07-18" -> Date).
      // bulkWrite casts but does NOT run validators, so validate here or an
      // unknown lead stage would sail straight into Mongo.
      const docs = items.map(
        (item, index) => new Model({ ...item, userId, _order: index })
      );
      for (const doc of docs) {
        const err = doc.validateSync();
        if (err) throw new HttpError(400, err.message);
      }

      await Model.bulkWrite([
        ...docs.map((doc) => {
          // Drop the freshly-minted _id: upserting an existing doc must not
          // try to replace its immutable _id.
          const { _id, ...fields } = doc.toObject();
          return {
            updateOne: {
              filter: { userId, id: fields.id },
              update: { $set: fields },
              upsert: true,
            },
          };
        }),
        { deleteMany: { filter: { userId, id: { $nin: ids } } } },
      ]);

      return this.get(userId);
    },
  };
}
