/**
 * Seed buyers from Excel workbooks into MongoDB.
 *
 *   npx tsx scripts/seed-buyers-from-excel.mts            # dry run (default)
 *   npx tsx scripts/seed-buyers-from-excel.mts --apply    # write
 *
 * MASTER_DATA_EXCEL_DIR (or ../Excel) is seed input only — the API does not
 * read these files at runtime.
 */
import mongoose from 'mongoose';
import config from '../src/config.js';
import { parseExcelDirectory } from '../src/lib/excel-master-data.js';
import { upsertBuyers } from '../src/services/buyer.service.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  if (!config.mongodbUri) throw new Error('Missing MONGODB_URI');

  const parsed = parseExcelDirectory();
  console.log(`${APPLY ? '' : '[dry run] '}buyer seed from Excel`);
  console.log(`Directory: ${parsed.excelDir}`);
  console.log(`Files: ${parsed.sourceFiles.length}`);
  console.log(`Rows: ${parsed.rows.length}`);
  console.log(`Buyers: ${parsed.buyers.length}`);

  if (!APPLY) {
    console.log('\n[dry run] nothing written. Re-run with --apply.');
    return;
  }

  await mongoose.connect(config.mongodbUri);
  try {
    const result = await upsertBuyers(parsed.buyers);
    const count = parsed.buyers.length;
    console.log(
      `\nOK  buyers collection: ${count} seeded (${result.upserted} upserted, ${result.matched} matched, ${result.removed} stale removed).`
    );
  } finally {
    await mongoose.disconnect();
  }
}

void main().catch(async (err) => {
  console.error('Seed failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
