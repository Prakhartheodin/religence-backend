import mongoose from 'mongoose';

/**
 * Append-only audit trail: one document per actual field-level change to a
 * business record (CRM entities + salt/medicine catalogue). `before`/`after`
 * are full snapshots, so any single change can be reverted or a deleted record
 * restored — see services/change-log.service.ts and scripts/changelog.ts.
 *
 * Deliberately NOT logged: auth/users, passwords, or Outlook tokens. Copying a
 * password hash or an OAuth token into a second collection would undo the
 * encryption they already have. Auth *events* (if ever wanted) belong in a
 * separate, sanitised log.
 *
 * No TTL: an audit log is meant to persist. Add
 * `schema.index({ at: 1 }, { expireAfterSeconds: N })` if you want automatic
 * pruning.
 */

export type ChangeOp = 'create' | 'update' | 'delete';

export type ChangeLogDoc = {
  at: Date;
  actorUserId: string;
  entity: string;
  docId: string;
  op: ChangeOp;
  before: unknown | null;
  after: unknown | null;
};

const changeLogSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    actorUserId: { type: String, default: '' },
    entity: { type: String, required: true },
    docId: { type: String, required: true },
    op: { type: String, required: true, enum: ['create', 'update', 'delete'] },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { collection: 'change_log', versionKey: false }
);

// History of one record, newest first; and a per-actor feed.
changeLogSchema.index({ entity: 1, docId: 1, at: -1 });
changeLogSchema.index({ actorUserId: 1, at: -1 });

export const ChangeLogModel =
  mongoose.models.ChangeLog || mongoose.model('ChangeLog', changeLogSchema);
