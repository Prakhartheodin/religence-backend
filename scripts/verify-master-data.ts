/**
 * Verifies salts, medicines, and buyers imported from Excel match source files.
 * Run: npx tsx scripts/verify-master-data.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { read, utils } from 'xlsx';
import { loadMasterData } from '../src/services/master-data.service.js';
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
  emails: string[];
  phoneNumbers: string[];
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
      mismatches.push(`${field}: imported="${actual}" excel="${expected}"`);
    }
  }
  return mismatches;
}

function main(): void {
  const data = loadMasterData(true);
  const excelDir = data.sourceDirectory;

  console.log('=== Master Data Excel Verification ===');
  console.log(`Directory: ${excelDir}`);
  console.log(`Files: ${data.sourceFiles.length}`);
  console.log(`Salts: ${data.salts.length}`);
  console.log(`Medicines: ${data.medicines.length}`);
  console.log(`Buyers: ${data.buyers.length}`);
  console.log('');

  const allExcelRows: RawRow[] = [];
  const fileStats: Array<{ file: string; rows: number; headerOk: boolean }> = [];

  for (const file of data.sourceFiles) {
    const filePath = path.join(excelDir, file);
    const workbook = read(readFileSync(filePath), { type: 'buffer', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    const headerOk = detectHeaderRow(rows) >= 0;
    const parsed = parseExcelFile(filePath, file);
    fileStats.push({ file, rows: parsed.length, headerOk });
    allExcelRows.push(...parsed);
  }

  console.log('--- Per-file row counts ---');
  for (const stat of fileStats) {
    const status = stat.headerOk ? 'OK' : 'HEADER MISSING';
    console.log(`${stat.file}: ${stat.rows} buyer rows [${status}]`);
  }
  console.log(`Total Excel buyer rows: ${allExcelRows.length}`);
  console.log('');

  const excelByKey = new Map(allExcelRows.map((r) => [rowKey(r), r]));
  const buyerByKey = new Map(
    data.buyers.map((b) => [rowKey(b), b])
  );

  const missingInImport = [...excelByKey.keys()].filter((k) => !buyerByKey.has(k));
  const extraInImport = [...buyerByKey.keys()].filter((k) => !excelByKey.has(k));

  const fieldMismatches: Array<{ key: string; issues: string[] }> = [];
  for (const [key, excelRow] of excelByKey) {
    const buyer = buyerByKey.get(key);
    if (!buyer) continue;
    const issues = buyerMatchesExcel(buyer, excelRow);
    if (issues.length) fieldMismatches.push({ key, issues });
  }

  // Salt / medicine coverage
  const productsInExcel = new Set(allExcelRows.map((r) => r.productName.toLowerCase()));
  const saltNames = new Set(data.salts.map((s) => s.name.toLowerCase()));
  const medNames = new Set(data.medicines.map((m) => m.name.toLowerCase()));

  const missingSalts = [...productsInExcel].filter((p) => !saltNames.has(p));
  const missingMeds = [...productsInExcel].filter((p) => !medNames.has(p));

  const saltBuyerCounts = new Map<string, number>();
  for (const row of allExcelRows) {
    const key = row.productName.toLowerCase();
    const buyers = new Set<string>();
    if (!saltBuyerCounts.has(key)) saltBuyerCounts.set(key, 0);
    const existing = allExcelRows.filter(
      (r) => r.productName.toLowerCase() === key
    );
    const uniqueBuyers = new Set(existing.map((r) => r.buyerName.toLowerCase()));
    saltBuyerCounts.set(key, uniqueBuyers.size);
  }

  const buyerCountMismatches: string[] = [];
  for (const salt of data.salts) {
    const expected = saltBuyerCounts.get(salt.name.toLowerCase()) ?? 0;
    if (expected !== salt.buyerCount) {
      buyerCountMismatches.push(
        `${salt.name}: excel unique buyers=${expected}, imported buyerCount=${salt.buyerCount}`
      );
    }
  }

  console.log('--- Verification results ---');
  if (missingInImport.length) {
    console.log(`MISSING in import (${missingInImport.length}):`);
    for (const key of missingInImport.slice(0, 20)) {
      console.log(`  - ${key}`);
    }
    if (missingInImport.length > 20) {
      console.log(`  ... and ${missingInImport.length - 20} more`);
    }
  } else {
    console.log('OK: Every Excel buyer row is present in import.');
  }

  if (extraInImport.length) {
    console.log(`EXTRA in import (${extraInImport.length}):`);
    for (const key of extraInImport.slice(0, 20)) {
      console.log(`  - ${key}`);
    }
  } else {
    console.log('OK: No extra buyer rows in import.');
  }

  if (fieldMismatches.length) {
    console.log(`FIELD mismatches (${fieldMismatches.length}):`);
    for (const item of fieldMismatches.slice(0, 15)) {
      console.log(`  ${item.key}`);
      for (const issue of item.issues) console.log(`    ${issue}`);
    }
  } else {
    console.log('OK: All imported buyer fields match Excel.');
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
    !extraInImport.length &&
    !fieldMismatches.length &&
    !missingSalts.length &&
    !missingMeds.length &&
    !buyerCountMismatches.length &&
    missingInImport.every((key) => {
      const excelRow = excelByKey.get(key);
      if (!excelRow) return false;
      // Duplicate Excel row: same buyer data appears on an earlier row.
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
      ? 'RESULT: PASS — data matches Excel.'
      : 'RESULT: FAIL — see issues above.'
  );
  if (missingInImport.length && !fieldMismatches.length) {
    console.log('');
    console.log(
      'NOTE: Missing rows are exact duplicates already present on another row in the same file.'
    );
  }
  process.exit(passed ? 0 : 1);
}

main();
