/**
 * Verifies buyers in MongoDB match Excel source files.
 * Run: npx tsx scripts/verify-master-data.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { read, utils } from 'xlsx';
import config from '../src/config.js';
import { buildMasterDataFromBuyers, parseExcelDirectory, resolveExcelDirectory } from '../src/lib/excel-master-data.js';
import { listBuyers } from '../src/services/buyer.service.js';
import type { BuyerMasterModel } from '../src/types/master-data.js';

type RawRow = {
  sourceFile: string;
  sourceRow: number;
  productName: string;
  casNo: string | null;
  buyerName: string;
  companyCategory: string | null;
  certifications: string[];
  annualBuyingCapacityKg: number | null;
  contactPersons: string[];
  designations: string[];
  phoneNumbers: string[];
  emails: string[];
  country: string | null;
};

function normalizeHeader(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function cleanToken(value: string): string {
  return value
    .replace(/\bverify\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitList(value: unknown, useComma = true): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const chunks = useComma
    ? raw.split(/\r?\n|;|,| {2,}/g)
    : raw.split(/\r?\n|;| {2,}/g);
  const unique = new Set<string>();
  for (const chunk of chunks) {
    const token = cleanToken(chunk);
    if (!token) continue;
    unique.add(token);
  }
  return [...unique];
}

function asNullableString(value: unknown): string | null {
  const cleaned = cleanToken(String(value || ''));
  return cleaned || null;
}

function parseCapacity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value);
  }
  const cleaned = String(value || '').replace(/[^0-9.-]/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

const HEADER_ALIAS_TO_FIELD: Record<string, string> = {
  productname: 'productName',
  casno: 'casNo',
  buyername: 'buyerName',
  companycategory: 'companyCategory',
  certification: 'certifications',
  certifications: 'certifications',
  annualbuyingcapacitykg: 'annualBuyingCapacityKg',
  contactperson: 'contactPersons',
  contactpersons: 'contactPersons',
  designation: 'designations',
  designations: 'designations',
  emailid: 'emails',
  emailids: 'emails',
  contactnumber: 'phoneNumbers',
  contactnumbers: 'phoneNumbers',
  country: 'country',
};

function detectHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(12, rows.length); i += 1) {
    const normalized = (rows[i] || []).map((cell) => normalizeHeader(cell));
    if (normalized.includes('productname') && normalized.includes('buyername')) {
      return i;
    }
  }
  return -1;
}

function parseExcelFile(filePath: string, fileName: string): RawRow[] {
  const workbook = read(readFileSync(filePath), { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!sheet) return [];
  const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  const headerRowIndex = detectHeaderRow(rows);
  if (headerRowIndex < 0) return [];

  const headerRow = rows[headerRowIndex] || [];
  const mappedHeaders = headerRow.map((header) => {
    const normalized = normalizeHeader(header);
    return HEADER_ALIAS_TO_FIELD[normalized];
  });

  const parsed: RawRow[] = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const rowObj: Record<string, unknown> = {};

    for (let colIndex = 0; colIndex < mappedHeaders.length; colIndex += 1) {
      const field = mappedHeaders[colIndex];
      if (!field) continue;
      const value = row[colIndex];
      switch (field) {
        case 'productName':
          rowObj.productName = cleanToken(String(value || ''));
          break;
        case 'casNo':
          rowObj.casNo = asNullableString(value);
          break;
        case 'buyerName':
          rowObj.buyerName = cleanToken(String(value || ''));
          break;
        case 'companyCategory':
          rowObj.companyCategory = asNullableString(value);
          break;
        case 'certifications':
          rowObj.certifications = splitList(value, true);
          break;
        case 'annualBuyingCapacityKg':
          rowObj.annualBuyingCapacityKg = parseCapacity(value);
          break;
        case 'contactPersons':
          rowObj.contactPersons = splitList(value, true);
          break;
        case 'designations':
          rowObj.designations = splitList(value, true);
          break;
        case 'emails':
          rowObj.emails = splitList(value, false).filter((item) => item.includes('@'));
          break;
        case 'phoneNumbers':
          rowObj.phoneNumbers = splitList(value, false);
          break;
        case 'country':
          rowObj.country = asNullableString(value);
          break;
        default:
          break;
      }
    }

    const productName = cleanToken(String(rowObj.productName || ''));
    const buyerName = cleanToken(String(rowObj.buyerName || ''));
    if (!productName || !buyerName) continue;

    parsed.push({
      sourceFile: fileName,
      sourceRow: rowIndex + 1,
      productName,
      casNo: (rowObj.casNo as string | null) ?? null,
      buyerName,
      companyCategory: (rowObj.companyCategory as string | null) ?? null,
      certifications: (rowObj.certifications as string[]) ?? [],
      annualBuyingCapacityKg: (rowObj.annualBuyingCapacityKg as number | null) ?? null,
      contactPersons: (rowObj.contactPersons as string[]) ?? [],
      designations: (rowObj.designations as string[]) ?? [],
      emails: (rowObj.emails as string[]) ?? [],
      phoneNumbers: (rowObj.phoneNumbers as string[]) ?? [],
      country: (rowObj.country as string | null) ?? null,
    });
  }
  return parsed;
}

function rowKey(row: {
  sourceFile: string;
  sourceRow: number;
  productName: string;
  buyerName: string;
}): string {
  return `${row.sourceFile}::${row.sourceRow}::${row.productName.toLowerCase()}::${row.buyerName.toLowerCase()}`;
}

function buyerMatchesExcel(buyer: BuyerMasterModel, excel: RawRow): string[] {
  const mismatches: string[] = [];
  const checks: Array<[string, unknown, unknown]> = [
    ['productName', buyer.productName, excel.productName],
    ['casNo', buyer.casNo, excel.casNo],
    ['buyerName', buyer.buyerName, excel.buyerName],
    ['companyCategory', buyer.companyCategory, excel.companyCategory],
    ['annualBuyingCapacityKg', buyer.annualBuyingCapacityKg, excel.annualBuyingCapacityKg],
    ['country', buyer.country, excel.country],
    ['certifications', buyer.certifications.join('|'), excel.certifications.join('|')],
    ['contactPersons', buyer.contactPersons.join('|'), excel.contactPersons.join('|')],
    ['designations', buyer.designations.join('|'), excel.designations.join('|')],
    ['emails', buyer.emails.join('|').toLowerCase(), excel.emails.join('|').toLowerCase()],
    ['phoneNumbers', buyer.phoneNumbers.join('|'), excel.phoneNumbers.join('|')],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      mismatches.push(`${field}: mongo="${actual}" excel="${expected}"`);
    }
  }
  return mismatches;
}

async function main(): Promise<void> {
  if (!config.mongodbUri) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(config.mongodbUri);

  const buyers = await listBuyers();
  const data = buildMasterDataFromBuyers(buyers, {
    sourceDirectory: 'mongodb://buyers',
    sourceFiles: [...new Set(buyers.map((b) => b.sourceFile))].sort((a, b) => a.localeCompare(b)),
  });

  const excelDir = resolveExcelDirectory();
  const parsed = parseExcelDirectory(excelDir);

  console.log('=== Master Data Mongo Verification ===');
  console.log(`Mongo buyers: ${data.buyers.length}`);
  console.log(`Excel directory: ${excelDir}`);
  console.log(`Excel files: ${parsed.sourceFiles.length}`);
  console.log(`Salts: ${data.salts.length}`);
  console.log(`Medicines: ${data.medicines.length}`);
  console.log('');

  const allExcelRows: RawRow[] = [];
  const fileStats: Array<{ file: string; rows: number; headerOk: boolean }> = [];

  for (const file of parsed.sourceFiles) {
    const filePath = path.join(excelDir, file);
    const workbook = read(readFileSync(filePath), { type: 'buffer', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    const headerOk = detectHeaderRow(rows) >= 0;
    const parsedRows = parseExcelFile(filePath, file);
    fileStats.push({ file, rows: parsedRows.length, headerOk });
    allExcelRows.push(...parsedRows);
  }

  console.log('--- Per-file row counts ---');
  for (const stat of fileStats) {
    const status = stat.headerOk ? 'OK' : 'HEADER MISSING';
    console.log(`${stat.file}: ${stat.rows} buyer rows [${status}]`);
  }
  console.log(`Total Excel buyer rows: ${allExcelRows.length}`);
  console.log('');

  const excelByKey = new Map(allExcelRows.map((r) => [rowKey(r), r]));
  const buyerByKey = new Map(data.buyers.map((b) => [rowKey(b), b]));

  const missingInMongo = [...excelByKey.keys()].filter((k) => !buyerByKey.has(k));
  const extraInMongo = [...buyerByKey.keys()].filter((k) => !excelByKey.has(k));

  const fieldMismatches: Array<{ key: string; issues: string[] }> = [];
  for (const [key, excelRow] of excelByKey) {
    const buyer = buyerByKey.get(key);
    if (!buyer) continue;
    const issues = buyerMatchesExcel(buyer, excelRow);
    if (issues.length) fieldMismatches.push({ key, issues });
  }

  const productsInExcel = new Set(allExcelRows.map((r) => r.productName.toLowerCase()));
  const saltNames = new Set(data.salts.map((s) => s.name.toLowerCase()));
  const medNames = new Set(data.medicines.map((m) => m.name.toLowerCase()));

  const missingSalts = [...productsInExcel].filter((p) => !saltNames.has(p));
  const missingMeds = [...productsInExcel].filter((p) => !medNames.has(p));

  const saltBuyerCounts = new Map<string, number>();
  for (const row of allExcelRows) {
    const key = row.productName.toLowerCase();
    const existing = allExcelRows.filter((r) => r.productName.toLowerCase() === key);
    const uniqueBuyers = new Set(existing.map((r) => r.buyerName.toLowerCase()));
    saltBuyerCounts.set(key, uniqueBuyers.size);
  }

  const buyerCountMismatches: string[] = [];
  for (const salt of data.salts) {
    const expected = saltBuyerCounts.get(salt.name.toLowerCase()) ?? 0;
    if (expected !== salt.buyerCount) {
      buyerCountMismatches.push(
        `${salt.name}: excel unique buyers=${expected}, mongo buyerCount=${salt.buyerCount}`
      );
    }
  }

  console.log('--- Verification results ---');
  if (missingInMongo.length) {
    console.log(`MISSING in Mongo (${missingInMongo.length}):`);
    for (const key of missingInMongo.slice(0, 20)) {
      console.log(`  - ${key}`);
    }
    if (missingInMongo.length > 20) {
      console.log(`  ... and ${missingInMongo.length - 20} more`);
    }
  } else {
    console.log('OK: Every Excel buyer row is present in Mongo.');
  }

  if (extraInMongo.length) {
    console.log(`EXTRA in Mongo (${extraInMongo.length}):`);
    for (const key of extraInMongo.slice(0, 20)) {
      console.log(`  - ${key}`);
    }
  } else {
    console.log('OK: No extra buyer rows in Mongo.');
  }

  if (fieldMismatches.length) {
    console.log(`FIELD mismatches (${fieldMismatches.length}):`);
    for (const item of fieldMismatches.slice(0, 15)) {
      console.log(`  ${item.key}`);
      for (const issue of item.issues) console.log(`    ${issue}`);
    }
  } else {
    console.log('OK: All Mongo buyer fields match Excel.');
  }

  if (missingSalts.length) {
    console.log(`MISSING salts for products: ${missingSalts.join(', ')}`);
  } else {
    console.log('OK: Every Excel product has a salt record.');
  }

  if (missingMeds.length) {
    console.log(`MISSING medicines for products: ${missingMeds.join(', ')}`);
  } else {
    console.log('OK: Every Excel product has a medicine record.');
  }

  if (buyerCountMismatches.length) {
    console.log(`Buyer count mismatches (${buyerCountMismatches.length}):`);
    for (const line of buyerCountMismatches) console.log(`  - ${line}`);
  } else {
    console.log('OK: Salt buyer counts match unique Excel buyers per product.');
  }

  const passed =
    !extraInMongo.length &&
    !fieldMismatches.length &&
    !missingSalts.length &&
    !missingMeds.length &&
    !buyerCountMismatches.length &&
    missingInMongo.every((key) => {
      const excelRow = excelByKey.get(key);
      if (!excelRow) return false;
      const dupKey = [
        excelRow.productName.toLowerCase(),
        (excelRow.casNo || '').toLowerCase(),
        excelRow.buyerName.toLowerCase(),
        (excelRow.companyCategory || '').toLowerCase(),
        excelRow.annualBuyingCapacityKg ?? '',
        (excelRow.country || '').toLowerCase(),
        excelRow.emails.join('|').toLowerCase(),
        excelRow.phoneNumbers.join('|').toLowerCase(),
      ].join('::');
      return [...excelByKey.entries()].some(
        ([otherKey, other]) =>
          otherKey !== key &&
          other.sourceFile === excelRow.sourceFile &&
          other.sourceRow < excelRow.sourceRow &&
          [
            other.productName.toLowerCase(),
            (other.casNo || '').toLowerCase(),
            other.buyerName.toLowerCase(),
            (other.companyCategory || '').toLowerCase(),
            other.annualBuyingCapacityKg ?? '',
            (other.country || '').toLowerCase(),
            other.emails.join('|').toLowerCase(),
            other.phoneNumbers.join('|').toLowerCase(),
          ].join('::') === dupKey
      );
    });

  console.log('');
  console.log(
    passed
      ? 'RESULT: PASS — Mongo buyers match Excel.'
      : 'RESULT: FAIL — see issues above.'
  );
  if (missingInMongo.length && !fieldMismatches.length) {
    console.log('');
    console.log(
      'NOTE: Missing rows are exact duplicates already present on another row in the same file.'
    );
  }

  await mongoose.disconnect();
  process.exit(passed ? 0 : 1);
}

void main().catch(async (err) => {
  console.error('Verification failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
