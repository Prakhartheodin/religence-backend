import { HttpError } from '../http-error.js';
import { CrmEntities, type CrmEntityName } from '../models/crm-entities.js';
import { recordChanges, type ChangeEntry } from './change-log.service.js';
import { parseListItems } from './crm-list.util.js';

export type CrmListService = {
  get: (userId: string) => Promise<Record<string, unknown>[]>;
  replace: (
    userId: string,
    input: unknown,
    baseIds?: string[] | null
  ) => Promise<Record<string, unknown>[]>;
};

/**
 * Storage is normalised (one document per item) but the API stays whole-array:
 * the client PUTs the full list and we diff it. Upsert everything sent, delete
 * anything that's gone. One bulkWrite, so it's a single round trip.
 *
 * `baseIds` is the set of ids the client was authoritative about when it built
 * this array (what it loaded + what it created). Deletes are scoped to that set,
 * so a stale second tab whose array is missing a lead ANOTHER tab just created
 * won't delete it — that lead was never in this client's baseIds. Without baseIds
 * (older client), we fall back to the original delete-everything-missing.
 */
// Canonical JSON for change-detection: sort object keys so a DB round-trip
// (alphabetical) and a freshly-built doc (schema order) compare equal when only
// key order differs. Arrays keep their order (order is meaningful).
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]])
        )
      : val
  );
}

export function crmList(entity: CrmEntityName): CrmListService {
  const Model = CrmEntities[entity];
  return {
    async get(userId) {
      const docs = await Model.find({ userId }).sort({ _order: 1 });
      return docs.map((d) => d.toJSON());
    },

    async replace(userId, input, baseIds) {
      const items = parseListItems(input);
      const ids = items.map((i) => String(i.id));

      // Hydrating each item casts it against the schema ("2026-07-18" -> Date).
      // bulkWrite casts but does NOT run validators, so validate here or an
      // unknown lead stage would sail straight into Mongo.
      const docs = items.map(
        (item, index) => new Model({ ...item, userId, _order: index })
      );
      for (const doc of docs) {
        try {
          await doc.validate();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Validation failed';
          throw new HttpError(400, message);
        }
      }

      const idSet = new Set(ids);
      const baseSet = Array.isArray(baseIds) ? new Set(baseIds.map(String)) : null;

      // Scope deletes to the client's known ids when it sent them; otherwise
      // fall back to "delete everything not sent" for older clients.
      const deleteFilter = baseSet
        ? { userId, id: { $in: [...baseSet], $nin: ids } }
        : { userId, id: { $nin: ids } };

      // Diff against what's stored so the audit log captures only real changes,
      // not the whole array on every debounced save. Compare business fields
      // (toJSON drops _id/userId/_order) but store the fuller object so a revert
      // is faithful (dates, order).
      const existing = await Model.find({ userId });
      const existingFull = new Map<string, Record<string, unknown>>();
      const existingBiz = new Map<string, string>();
      for (const d of existing) {
        const id = String((d as unknown as { id: string }).id);
        const { _id, ...full } = d.toObject();
        void _id;
        existingFull.set(id, full);
        existingBiz.set(id, stableStringify(d.toJSON()));
      }

      const changes: ChangeEntry[] = [];
      docs.forEach((doc, i) => {
        const id = ids[i];
        const { _id, ...full } = doc.toObject();
        void _id;
        const biz = stableStringify(doc.toJSON());
        if (!existingBiz.has(id)) {
          changes.push({ actorUserId: userId, entity, docId: id, op: 'create', before: null, after: full });
        } else if (existingBiz.get(id) !== biz) {
          changes.push({ actorUserId: userId, entity, docId: id, op: 'update', before: existingFull.get(id), after: full });
        }
      });
      for (const [id, full] of existingFull) {
        const willDelete = !idSet.has(id) && (baseSet ? baseSet.has(id) : true);
        if (willDelete) {
          changes.push({ actorUserId: userId, entity, docId: id, op: 'delete', before: full, after: null });
        }
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
        { deleteMany: { filter: deleteFilter } },
      ]);

      await recordChanges(changes);

      return this.get(userId);
    },
  };
}
