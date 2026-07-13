// One-off: explode the old one-doc-per-user `items: [Mixed]` arrays into one
// typed document per CRM item, letting the schemas cast dates/enums on write.
// Usage: npx tsx scripts/normalize-crm.ts [--apply]
// Dry-run by default. Reads the legacy blobs, writes the new collections.
//
// Legacy layout: leads/contacts/companies/deals/crm_timeline/crm_emails held
// { userId, items: [...] }; master_lists held { userId, kind, items: [...] }.
// New layout: one doc per item, in the entity's own collection.
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectMongo } from '../src/db/mongo.js';
import { CrmEntities, type CrmEntityName } from '../src/models/crm-entities.js';

const apply = process.argv.includes('--apply');

// legacy collection -> new entity. master_lists fans out by `kind`.
const FROM_BLOB: Record<string, CrmEntityName> = {
  companies: 'companies',
  contacts: 'contacts',
  leads: 'leads',
  deals: 'deals',
  crm_timeline: 'timeline',
  crm_emails: 'emails',
};

type Blob = { userId: string; kind?: string; items?: Record<string, unknown>[] };

void (async () => {
  await connectMongo();
  const db = mongoose.connection;
  console.log(apply ? `APPLY (db: ${db.name})\n` : `DRY RUN — pass --apply (db: ${db.name})\n`);

  // Pull every legacy blob first; the new docs land in the same collections,
  // so nothing may be written until all the old shapes have been read.
  const work: { entity: CrmEntityName; userId: string; items: Record<string, unknown>[] }[] = [];

  for (const [collection, entity] of Object.entries(FROM_BLOB)) {
    const blobs = (await db.collection(collection).find({ items: { $exists: true } }).toArray()) as unknown as Blob[];
    for (const b of blobs) {
      work.push({ entity, userId: b.userId, items: b.items ?? [] });
    }
  }
  for (const b of (await db.collection('master_lists').find({}).toArray()) as unknown as Blob[]) {
    if (b.kind === 'salts' || b.kind === 'medicines') {
      work.push({ entity: b.kind, userId: b.userId, items: b.items ?? [] });
    }
  }

  const totals: Record<string, number> = {};
  for (const w of work) totals[w.entity] = (totals[w.entity] ?? 0) + w.items.length;
  for (const [entity, n] of Object.entries(totals)) {
    console.log(`  ${entity.padEnd(12)} ${n} items -> ${n} docs`);
  }
  if (!work.length) console.log('  nothing to migrate (already normalised?)');

  if (!apply) {
    await mongoose.disconnect();
    return;
  }

  // Drop the legacy blobs, then insert typed docs. Schemas do the casting:
  // "2026-07-18" -> Date, unknown lead stage -> rejected.
  for (const collection of [...Object.keys(FROM_BLOB), 'master_lists']) {
    await db.collection(collection).deleteMany({ items: { $exists: true } });
  }

  for (const { entity, userId, items } of work) {
    const Model = CrmEntities[entity];
    for (const [index, item] of items.entries()) {
      await Model.updateOne(
        { userId, id: String(item.id) },
        { $set: { ...item, userId, _order: index } },
        { upsert: true, runValidators: true }
      );
    }
  }

  console.log('\nResult:');
  for (const entity of Object.keys(totals) as CrmEntityName[]) {
    console.log(`  ${entity.padEnd(12)} ${await CrmEntities[entity].countDocuments()} docs`);
  }
  await mongoose.disconnect();
})();
