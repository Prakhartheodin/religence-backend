// Restore the CRM collections in `religence` from `religence_prenorm_backup`,
// and drop the stale one-doc-per-user unique indexes that block normalisation.
// Usage: npx tsx scripts/restore-crm-from-backup.ts [--apply]
//
// Scoped on purpose: users / auth_tokens / outlook_accounts / email_templates
// are never touched. A collection is only cleared if its backup has documents,
// so an empty/partial backup can't wipe live data.
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectMongo } from '../src/db/mongo.js';

const apply = process.argv.includes('--apply');
const BACKUP_DB = 'religence_prenorm_backup';

const CRM_COLLECTIONS = [
  'leads',
  'contacts',
  'companies',
  'deals',
  'crm_timeline',
  'crm_emails',
  'master_lists',
  'salts',
  'medicines',
];

void (async () => {
  await connectMongo();
  const client = mongoose.connection.getClient();
  const live = client.db(mongoose.connection.name);
  const backup = client.db(BACKUP_DB);
  console.log(
    apply
      ? `APPLY: ${BACKUP_DB} -> ${live.databaseName}\n`
      : `DRY RUN (pass --apply): ${BACKUP_DB} -> ${live.databaseName}\n`
  );

  for (const name of CRM_COLLECTIONS) {
    const docs = await backup.collection(name).find().toArray();
    const current = await live.collection(name).countDocuments();

    if (!docs.length) {
      console.log(`  skip    ${name.padEnd(16)} backup empty — leaving ${current} live docs alone`);
      continue;
    }
    console.log(`  restore ${name.padEnd(16)} ${docs.length} docs  (replaces ${current})`);
    if (!apply) continue;

    await live.collection(name).deleteMany({});
    await live.collection(name).insertMany(docs);
  }

  console.log('\nStale indexes (one unique userId per collection — blocks one-doc-per-item):');
  for (const name of CRM_COLLECTIONS) {
    let indexes: { name: string; key: Record<string, unknown>; unique?: boolean }[];
    try {
      indexes = (await live.collection(name).indexes()) as typeof indexes;
    } catch {
      continue; // collection doesn't exist yet
    }
    for (const idx of indexes) {
      const keys = Object.keys(idx.key);
      if (idx.unique && keys.length === 1 && keys[0] === 'userId') {
        console.log(`  ${apply ? 'drop   ' : 'would drop'} ${name}.${idx.name}`);
        if (apply) await live.collection(name).dropIndex(idx.name);
      }
    }
  }

  await mongoose.disconnect();
})();
