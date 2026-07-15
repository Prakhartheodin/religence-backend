/**
 * A medicine now links to many salts: `saltId: string` -> `saltIds: string[]`.
 *
 *   npx tsx scripts/migrate-medicine-saltids.ts            # dry run (default)
 *   npx tsx scripts/migrate-medicine-saltids.ts --apply    # write
 *
 * Wraps each existing single saltId into a one-element saltIds array and drops
 * the old field. Idempotent: docs already on saltIds are skipped. Raw driver
 * only, so a partly-migrated collection never blocks the model's index build.
 */
import mongoose from 'mongoose';
import config from '../src/config.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  if (!config.mongodbUri) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(config.mongodbUri);
  const col = mongoose.connection.db!.collection('medicines');

  const stale = await col.find({ saltId: { $exists: true } }).toArray();
  console.log(`${APPLY ? '' : '[dry run] '}${stale.length} medicine(s) still on saltId`);

  let changed = 0;
  for (const doc of stale) {
    const saltId = String((doc as { saltId?: string }).saltId ?? '').trim();
    const saltIds = saltId ? [saltId] : [];
    console.log(`  ${doc.id}: saltId "${saltId}" -> saltIds [${saltIds.join(', ')}]`);
    if (APPLY) {
      await col.updateOne({ _id: doc._id }, { $set: { saltIds }, $unset: { saltId: '' } });
    }
    changed++;
  }

  await mongoose.disconnect();
  console.log(
    APPLY
      ? `OK  migrated ${changed} medicine(s) to saltIds.`
      : '[dry run] nothing written. Re-run with --apply.'
  );
}

void main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
