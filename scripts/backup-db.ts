/**
 * Mirror the live database into a backup database on the same cluster.
 *
 *   npx tsx scripts/backup-db.ts --dry-run   # report only, change nothing
 *   npx tsx scripts/backup-db.ts             # overwrite the backup
 *
 * Source is whatever MONGODB_URI points at (religence). Target defaults to
 * "<source>_backup" and can be overridden with BACKUP_DB.
 *
 * The backup is a full overwrite, not an append: target collections are dropped
 * first, so the backup is always an exact mirror of the source at run time.
 * Counts are verified per collection afterwards — a backup you have not counted
 * is a backup you do not have.
 *
 * ponytail: documents only, no index copy. Mongoose rebuilds indexes from the
 * schemas on boot, and restore-crm-from-backup.ts enumerates and drops stale
 * ones explicitly. If you ever restore into a cluster with no app to rebuild
 * them, recreate indexes from the models first.
 */
import mongoose from 'mongoose';
import config from '../src/config.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;

async function main(): Promise<void> {
  if (!config.mongodbUri) throw new Error('Missing MONGODB_URI');

  await mongoose.connect(config.mongodbUri);
  const client = mongoose.connection.getClient();
  const sourceName = mongoose.connection.db!.databaseName;
  const targetName = (process.env.BACKUP_DB ?? `${sourceName}_backup`).trim();

  if (targetName === sourceName) {
    throw new Error(`Refusing to back up ${sourceName} onto itself.`);
  }

  const source = client.db(sourceName);
  const target = client.db(targetName);

  const collections = (await source.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  console.log(`${DRY_RUN ? '[dry run] ' : ''}${sourceName} -> ${targetName}\n`);
  console.log(`  ${'collection'.padEnd(20)} ${'source'.padStart(6)} ${'backup'.padStart(7)}`);
  console.log(`  ${'-'.repeat(20)} ${'-'.repeat(6)} ${'-'.repeat(7)}`);

  let sourceTotal = 0;
  let backedUpTotal = 0;
  const mismatches: string[] = [];

  for (const name of collections) {
    const docs = await source.collection(name).find({}).toArray();
    sourceTotal += docs.length;

    if (DRY_RUN) {
      console.log(`  ${name.padEnd(20)} ${String(docs.length).padStart(6)} ${'—'.padStart(7)}`);
      continue;
    }

    // Full overwrite: the backup mirrors the source exactly, never accumulates.
    await target.collection(name).drop().catch(() => undefined);

    for (let i = 0; i < docs.length; i += BATCH) {
      const chunk = docs.slice(i, i + BATCH);
      if (chunk.length) await target.collection(name).insertMany(chunk, { ordered: false });
    }

    // Count from the target, not from what we think we wrote.
    const written = await target.collection(name).countDocuments();
    backedUpTotal += written;
    if (written !== docs.length) mismatches.push(`${name}: source=${docs.length} backup=${written}`);

    console.log(
      `  ${name.padEnd(20)} ${String(docs.length).padStart(6)} ${String(written).padStart(7)}` +
        (written === docs.length ? '' : '   <-- MISMATCH')
    );
  }

  console.log(`  ${'-'.repeat(20)} ${'-'.repeat(6)} ${'-'.repeat(7)}`);
  console.log(
    `  ${'TOTAL'.padEnd(20)} ${String(sourceTotal).padStart(6)} ${String(DRY_RUN ? '—' : backedUpTotal).padStart(7)}`
  );

  if (DRY_RUN) {
    console.log(`\n[dry run] nothing written. Re-run without --dry-run to overwrite ${targetName}.`);
  } else if (mismatches.length) {
    console.error(`\nBACKUP FAILED — counts do not match:\n  ${mismatches.join('\n  ')}`);
    await mongoose.disconnect();
    process.exit(1);
  } else {
    console.log(`\nOK  ${targetName} verified: ${backedUpTotal} documents across ${collections.length} collections.`);
  }

  await mongoose.disconnect();
}

void main().catch(async (err) => {
  console.error('Backup failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
