/**
 * Salts and medicines are a SHARED catalogue, not per-user lists.
 *
 *   npx tsx scripts/migrate-shared-catalogue.ts            # dry run (default)
 *   npx tsx scripts/migrate-shared-catalogue.ts --apply    # write
 *
 * They were routed through crmList(), the generic per-user list service, so every
 * user who logged in got their own copy of the same 10 Excel-derived rows (20 docs
 * for 2 users). Nothing ever read the owner: the API strips `userId` before it
 * reaches the client, and leads reference salts by NAME, not id.
 *
 * This collapses the duplicates to one row per id, drops `userId`/`_order`, and
 * replaces the {userId, id} unique index with {id} unique.
 *
 * Raw driver only — deliberately does NOT import the mongoose models. Importing
 * them would let autoIndex try to build {id:1} unique while the duplicates still
 * exist, and the build would fail.
 */
import mongoose from 'mongoose';
import config from '../src/config.js';

const APPLY = process.argv.includes('--apply');

type Spec = { name: string; contentFields: string[] };
const SPECS: Spec[] = [
  { name: 'salts', contentFields: ['name'] },
  { name: 'medicines', contentFields: ['saltId', 'name', 'dosageForm'] },
];

/** Stable, key-sorted signature of the fields that actually carry meaning. */
function signature(doc: Record<string, unknown>, fields: string[]): string {
  const norm: Record<string, string> = {};
  for (const f of [...fields].sort()) {
    const v = doc[f];
    norm[f] = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  }
  return JSON.stringify(norm);
}

async function main(): Promise<void> {
  if (!config.mongodbUri) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db!;
  console.log(`${APPLY ? '' : '[dry run] '}shared catalogue migration on "${db.databaseName}"\n`);

  let conflicts = 0;

  for (const spec of SPECS) {
    const col = db.collection(spec.name);
    const docs = await col.find({}).toArray();
    console.log(`--- ${spec.name}: ${docs.length} documents`);

    // --- Phase A: group by id, prove the duplicates are content-identical -----
    const missingId = docs.filter((d) => !String((d as never as { id?: string }).id ?? '').trim());
    if (missingId.length) {
      console.error(`  ABORT: ${missingId.length} document(s) have no \`id\`.`);
      conflicts++;
      continue;
    }

    const groups = new Map<string, Record<string, unknown>[]>();
    for (const d of docs as Record<string, unknown>[]) {
      const id = String(d.id);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(d);
    }

    const dupes = [...groups.entries()].filter(([, g]) => g.length > 1);
    console.log(`    distinct ids: ${groups.size}   duplicated ids: ${dupes.length}`);

    let bad = 0;
    for (const [id, group] of dupes) {
      const sigs = new Set(group.map((d) => signature(d, spec.contentFields)));
      if (sigs.size > 1) {
        bad++;
        console.error(`  CONFLICT ${id} — ${sigs.size} differing versions:`);
        for (const s of sigs) console.error(`      ${s}`);
      }
    }
    if (bad) {
      console.error(`  ABORT: ${bad} id(s) differ between users. A human must pick a winner.`);
      conflicts++;
      continue;
    }
    if (dupes.length) console.log(`    all duplicates are content-identical — safe to collapse`);

    // Survivor = lowest _id, for determinism across runs.
    const losers: unknown[] = [];
    for (const [, group] of groups) {
      const sorted = [...group].sort((a, b) => String(a._id).localeCompare(String(b._id)));
      losers.push(...sorted.slice(1).map((d) => d._id));
    }

    if (losers.length) {
      console.log(`    ${APPLY ? 'deleting' : 'would delete'} ${losers.length} duplicate row(s)`);
      if (APPLY) await col.deleteMany({ _id: { $in: losers as never[] } });
    }

    const withUser = await col.countDocuments({ userId: { $exists: true } });
    if (withUser) {
      console.log(`    ${APPLY ? 'unsetting' : 'would unset'} userId/_order on ${withUser} row(s)`);
      if (APPLY) await col.updateMany({}, { $unset: { userId: '', _order: '' } });
    }

    // --- Phase C: indexes. ENUMERATE — never hardcode names. -----------------
    // The real names are `userId_1_id_1` and `userId_1__order_1`; a hardcoded
    // dropIndex('userId_1') throws IndexNotFound and half-migrates the DB.
    for (const idx of await col.indexes()) {
      if (idx.name === '_id_') continue;
      const keys = Object.keys(idx.key);
      const staleUserIndex = keys.includes('userId');
      const nonUniqueIdIndex = keys.length === 1 && keys[0] === 'id' && !idx.unique;
      if (staleUserIndex || nonUniqueIdIndex) {
        console.log(`    ${APPLY ? 'drop' : 'would drop'} index ${idx.name} (${keys.join(',')})`);
        if (APPLY) await col.dropIndex(idx.name!);
      }
    }
    if (APPLY) {
      await col.createIndex({ id: 1 }, { unique: true, name: 'id_1' });
      console.log(`    created unique index id_1`);
    }

    // --- Phase D: verify -----------------------------------------------------
    if (APPLY) {
      const n = await col.countDocuments();
      const ids = (await col.distinct('id')).length;
      const stillOwned = await col.countDocuments({ userId: { $exists: true } });
      const ok = n === ids && stillOwned === 0;
      console.log(`    RESULT ${docs.length} -> ${n} docs, ${ids} distinct ids, ${stillOwned} still owned  ${ok ? 'OK' : 'FAILED'}`);
      if (!ok) conflicts++;
    }
    console.log();
  }

  // Orphan check: a medicine whose salt no longer exists. Warn, do not abort.
  const saltIds = new Set(await db.collection('salts').distinct('id'));
  const orphans = (await db.collection('medicines').find({}).toArray()).filter(
    (m) => !saltIds.has(String((m as never as { saltId?: string }).saltId ?? ''))
  );
  if (orphans.length) {
    console.warn(`WARN  ${orphans.length} medicine(s) reference a salt that does not exist.`);
  }

  await mongoose.disconnect();

  if (conflicts) {
    console.error(`\nFAILED — ${conflicts} collection(s) could not be migrated. Nothing was left half-done.`);
    process.exit(1);
  }
  console.log(
    APPLY
      ? 'OK  catalogue is shared: one row per salt/medicine, no userId, unique on id.'
      : '[dry run] nothing written. Re-run with --apply.'
  );
}

void main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
