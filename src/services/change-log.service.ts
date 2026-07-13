import type mongoose from 'mongoose';
import { MedicineCatalogue, SaltCatalogue } from '../models/catalogue.js';
import { ChangeLogModel, type ChangeOp } from '../models/change-log.model.js';
import { CrmEntities } from '../models/crm-entities.js';

export type ChangeEntry = {
  actorUserId: string;
  entity: string;
  docId: string;
  op: ChangeOp;
  before?: unknown | null;
  after?: unknown | null;
};

type AnyModel = mongoose.Model<Record<string, unknown>>;

function isCrmEntity(entity: string): boolean {
  return Object.prototype.hasOwnProperty.call(CrmEntities, entity);
}

/** Maps a logged `entity` back to the collection it came from, for revert. */
function modelFor(entity: string): AnyModel {
  if (isCrmEntity(entity)) {
    return CrmEntities[entity as keyof typeof CrmEntities] as AnyModel;
  }
  if (entity === 'salts') return SaltCatalogue as AnyModel;
  if (entity === 'medicines') return MedicineCatalogue as AnyModel;
  throw new Error(`change-log: unknown entity "${entity}"`);
}

/**
 * Persist a batch of changes. Best-effort: the underlying data write has already
 * committed by the time we get here, so a logging failure is warned and
 * swallowed rather than failing the user's request.
 */
export async function recordChanges(entries: ChangeEntry[]): Promise<void> {
  if (!entries.length) return;
  try {
    await ChangeLogModel.insertMany(
      entries.map((e) => ({ ...e, at: new Date() })),
      { ordered: false }
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[change-log] failed to record changes:', err);
  }
}

export async function listChanges(filter: {
  entity?: string;
  docId?: string;
  actorUserId?: string;
  limit?: number;
}): Promise<ChangeLogDocLean[]> {
  const query: Record<string, unknown> = {};
  if (filter.entity) query.entity = filter.entity;
  if (filter.docId) query.docId = filter.docId;
  if (filter.actorUserId) query.actorUserId = filter.actorUserId;
  return ChangeLogModel.find(query)
    .sort({ at: -1 })
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 1000))
    .lean<ChangeLogDocLean[]>();
}

type ChangeLogDocLean = {
  _id: mongoose.Types.ObjectId;
  at: Date;
  actorUserId: string;
  entity: string;
  docId: string;
  op: ChangeOp;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/** Filter that uniquely identifies the source record a change refers to. */
function keyFilter(change: ChangeLogDocLean): Record<string, unknown> {
  const src = (change.before ?? change.after ?? {}) as Record<string, unknown>;
  if (isCrmEntity(change.entity)) {
    return { userId: src.userId, id: change.docId };
  }
  return { id: change.docId };
}

/**
 * Undo a single logged change and record the undo as a new change:
 *   - create  → delete the record
 *   - update  → restore the `before` snapshot
 *   - delete  → re-insert the `before` snapshot
 * Returns a short human-readable summary.
 */
export async function revertChange(changeId: string): Promise<string> {
  const change = await ChangeLogModel.findById(changeId).lean<ChangeLogDocLean>();
  if (!change) throw new Error(`change ${changeId} not found`);

  const model = modelFor(change.entity);
  const filter = keyFilter(change);

  if (change.op === 'create') {
    await model.deleteOne(filter);
  } else {
    if (!change.before) throw new Error(`change ${changeId} has no "before" to restore`);
    const { _id, ...fields } = change.before as Record<string, unknown>;
    void _id;
    await model.updateOne(filter, { $set: fields }, { upsert: true });
  }

  // The revert is itself an auditable edit: it swaps before/after.
  await recordChanges([
    {
      actorUserId: 'revert',
      entity: change.entity,
      docId: change.docId,
      op: change.op === 'create' ? 'delete' : change.op === 'delete' ? 'create' : 'update',
      before: change.after,
      after: change.op === 'create' ? null : change.before,
    },
  ]);

  return `Reverted ${change.op} on ${change.entity}/${change.docId} (change ${changeId}).`;
}
