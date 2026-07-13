/**
 * Inspect and revert the change log (audit trail of every CRM + catalogue edit).
 *
 *   npx tsx scripts/changelog.ts list                     # 50 most recent changes
 *   npx tsx scripts/changelog.ts list leads               # recent changes to leads
 *   npx tsx scripts/changelog.ts list leads lead-123      # history of one record
 *   npx tsx scripts/changelog.ts show <changeId>          # full before/after
 *   npx tsx scripts/changelog.ts revert <changeId>        # undo one change
 *
 * Revert is a real write and is logged as its own change, so it too can be
 * undone. This lives as a script, not an HTTP route, on purpose: restoring data
 * is powerful and belongs behind shell access, not a click.
 */
import mongoose from 'mongoose';
import config from '../src/config.js';
import { ChangeLogModel } from '../src/models/change-log.model.js';
import { listChanges, revertChange } from '../src/services/change-log.service.js';

function fmt(c: {
  _id: unknown;
  at: Date;
  op: string;
  entity: string;
  docId: string;
  actorUserId: string;
}): string {
  const at = new Date(c.at).toISOString().replace('T', ' ').slice(0, 19);
  return `${String(c._id)}  ${at}  ${c.op.padEnd(6)}  ${c.entity}/${c.docId}  by ${c.actorUserId || '—'}`;
}

async function main(): Promise<void> {
  if (!config.mongodbUri) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(config.mongodbUri);

  const [cmd, a, b] = process.argv.slice(2);

  if (!cmd || cmd === 'list') {
    const rows = await listChanges({ entity: a, docId: b, limit: 50 });
    if (!rows.length) {
      // eslint-disable-next-line no-console
      console.log('No changes recorded.');
    } else {
      // eslint-disable-next-line no-console
      rows.forEach((r) => console.log(fmt(r)));
    }
  } else if (cmd === 'show') {
    if (!a) throw new Error('usage: show <changeId>');
    const doc = await ChangeLogModel.findById(a).lean();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(doc, null, 2));
  } else if (cmd === 'revert') {
    if (!a) throw new Error('usage: revert <changeId>');
    const msg = await revertChange(a);
    // eslint-disable-next-line no-console
    console.log(msg);
  } else {
    throw new Error(`Unknown command "${cmd}". Use: list | show | revert`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
