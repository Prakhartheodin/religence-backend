// One-off: copy every collection from the accidental `test` DB into `religence`.
// The app defaulted to `test` because MONGODB_URI carried no database name.
// Usage: npx tsx scripts/migrate-test-to-religence.ts [--apply]
// Dry-run by default. Source (`test`) is never modified — it stays as a backup.
import 'dotenv/config';
import mongoose from 'mongoose';

const SRC = 'test';
const DST = 'religence';
// Dead collection from the old single-blob CRM design; nothing reads it now.
const SKIP = new Set(['crm_states']);

const apply = process.argv.includes('--apply');

void (async () => {
  const uri = (process.env.MONGODB_URI ?? '').trim();
  if (!uri) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  const client = mongoose.connection.getClient();
  const src = client.db(SRC);
  const dst = client.db(DST);

  console.log(apply ? `APPLY: ${SRC} -> ${DST}\n` : `DRY RUN (pass --apply): ${SRC} -> ${DST}\n`);

  for (const { name } of await src.listCollections().toArray()) {
    const docs = await src.collection(name).find().toArray();
    const before = await dst.collection(name).countDocuments().catch(() => 0);

    if (SKIP.has(name)) {
      console.log(`  skip    ${name.padEnd(18)} (legacy, ${docs.length} docs left in ${SRC})`);
      continue;
    }
    console.log(`  copy    ${name.padEnd(18)} ${docs.length} docs  (replaces ${before} in ${DST})`);
    if (!apply || docs.length === 0) continue;

    await dst.collection(name).deleteMany({});
    await dst.collection(name).insertMany(docs);
  }

  if (apply) {
    console.log(`\nResult in ${DST}:`);
    for (const { name } of await dst.listCollections().toArray()) {
      console.log(`  ${name.padEnd(18)} ${await dst.collection(name).countDocuments()}`);
    }
  }
  await mongoose.disconnect();
})();
