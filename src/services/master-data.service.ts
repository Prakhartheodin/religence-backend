import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { read, utils } from 'xlsx';import config from '../config.js';
import { HttpError } from '../http-error.js';
import type {
  BuyerMasterModel,
  MasterDataModel,
  MedicineMasterModel,
  SaltMasterModel,
} from '../types/master-data.js';

type CanonicalRow = {
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
  sourceFile: string;
  sourceRow: number;
};

type FileSignature = {
  name: string;
  size: number;
  mtimeMs: number;
};

const HEADER_ALIAS_TO_FIELD: Record<string, keyof Omit<CanonicalRow, 'sourceFile' | 'sourceRow'>> = {
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

const DOSAGE_FORM_API = 'API';
const CACHE_MAX_AGE_MS = 60_000;

let cache: {
  signature: string;
  loadedAt: number;
  data: MasterDataModel;
} | null = null;

function resolveExcelDirectory(): string {
  const fromEnv = config.masterDataExcelDir;
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? path.normalize(fromEnv)
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.resolve(process.cwd(), '..', 'Excel');
}

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'unknown';
}

function listSourceFiles(excelDir: string): string[] {
  if (!existsSync(excelDir)) {
    throw new HttpError(
      500,
      `Master data directory not found: ${excelDir}. Expected .xlsx/.xls/.csv source files in this path.`
    );
  }
  const files = readdirSync(excelDir)
    .filter((name) => /\.(xlsx|xls|csv)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    throw new HttpError(
      500,
      `No source files found in ${excelDir}. Expected .xlsx/.xls/.csv files for salt and medicine master import.`
    );
  }
  return files;
}

function buildSignature(excelDir: string, files: string[]): string {
  const signatures: FileSignature[] = files.map((name) => {
    const st = statSync(path.join(excelDir, name));
    return { name, size: st.size, mtimeMs: st.mtimeMs };
  });
  return JSON.stringify(signatures);
}

function detectHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(12, rows.length); i += 1) {
    const normalized = (rows[i] || []).map((cell) => normalizeHeader(cell));
    if (normalized.includes('productname') && normalized.includes('buyername')) {
      return i;
    }
  }
  throw new HttpError(
    500,
    'Unable to detect header row in one of the master files. Ensure each file contains Product Name and Buyer Name columns.'
  );
}

function parseWorkbookRows(filePath: string, fileName: string): CanonicalRow[] {
  const workbook = read(readFileSync(filePath), { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });  if (!rows.length) return [];

  const headerRowIndex = detectHeaderRow(rows);
  const headerRow = rows[headerRowIndex] || [];
  const mappedHeaders = headerRow.map((header) => {
    const normalized = normalizeHeader(header);
    return HEADER_ALIAS_TO_FIELD[normalized];
  });

  const parsedRows: CanonicalRow[] = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const rowObj: Partial<CanonicalRow> = {};

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

    const productName = cleanToken(rowObj.productName || '');
    const buyerName = cleanToken(rowObj.buyerName || '');
    if (!productName || !buyerName) {
      continue;
    }

    parsedRows.push({
      productName,
      casNo: rowObj.casNo ?? null,
      buyerName,
      companyCategory: rowObj.companyCategory ?? null,
      certifications: rowObj.certifications ?? [],
      annualBuyingCapacityKg: rowObj.annualBuyingCapacityKg ?? null,
      contactPersons: rowObj.contactPersons ?? [],
      designations: rowObj.designations ?? [],
      emails: rowObj.emails ?? [],
      phoneNumbers: rowObj.phoneNumbers ?? [],
      country: rowObj.country ?? null,
      sourceFile: fileName,
      sourceRow: rowIndex + 1,
    });
  }

  return parsedRows;
}

function buildModels(rows: CanonicalRow[], excelDir: string, sourceFiles: string[]): MasterDataModel {
  const dedupedRows: CanonicalRow[] = [];
  const seenRows = new Set<string>();
  for (const row of rows) {
    const key = [
      row.productName.toLowerCase(),
      (row.casNo || '').toLowerCase(),
      row.buyerName.toLowerCase(),
      (row.companyCategory || '').toLowerCase(),
      row.annualBuyingCapacityKg ?? '',
      (row.country || '').toLowerCase(),
      row.emails.join('|').toLowerCase(),
      row.phoneNumbers.join('|').toLowerCase(),
    ].join('::');
    if (seenRows.has(key)) continue;
    seenRows.add(key);
    dedupedRows.push(row);
  }

  const saltsByProduct = new Map<
    string,
    {
      id: string;
      name: string;
      casNumbers: Set<string>;
      sourceFiles: Set<string>;
      buyerNames: Set<string>;
      totalAnnualBuyingCapacityKg: number;
      companyCategories: Set<string>;
      countries: Set<string>;
      certifications: Set<string>;
    }
  >();

  const medicinesByProduct = new Map<
    string,
    {
      id: string;
      saltId: string;
      name: string;
      dosageForm: string;
      casNumber: string | null;
      sourceFiles: Set<string>;
      buyerNames: Set<string>;
      totalAnnualBuyingCapacityKg: number;
    }
  >();

  const buyers: BuyerMasterModel[] = [];

  for (const row of dedupedRows) {
    const productKey = row.productName.toLowerCase();
    const saltId = `salt-${slugify(row.productName)}`;
    const medicineId = `med-${slugify(row.productName)}`;

    if (!saltsByProduct.has(productKey)) {
      saltsByProduct.set(productKey, {
        id: saltId,
        name: row.productName,
        casNumbers: new Set<string>(),
        sourceFiles: new Set<string>(),
        buyerNames: new Set<string>(),
        totalAnnualBuyingCapacityKg: 0,
        companyCategories: new Set<string>(),
        countries: new Set<string>(),
        certifications: new Set<string>(),
      });
    }

    if (!medicinesByProduct.has(productKey)) {
      medicinesByProduct.set(productKey, {
        id: medicineId,
        saltId,
        name: row.productName,
        dosageForm: DOSAGE_FORM_API,
        casNumber: row.casNo,
        sourceFiles: new Set<string>(),
        buyerNames: new Set<string>(),
        totalAnnualBuyingCapacityKg: 0,
      });
    }

    const salt = saltsByProduct.get(productKey)!;
    const medicine = medicinesByProduct.get(productKey)!;

    if (row.casNo) salt.casNumbers.add(row.casNo);
    salt.sourceFiles.add(row.sourceFile);
    salt.buyerNames.add(row.buyerName);
    if (row.companyCategory) salt.companyCategories.add(row.companyCategory);
    if (row.country) salt.countries.add(row.country);
    for (const cert of row.certifications) {
      salt.certifications.add(cert);
    }
    if (row.annualBuyingCapacityKg !== null) {
      salt.totalAnnualBuyingCapacityKg += row.annualBuyingCapacityKg;
    }

    if (!medicine.casNumber && row.casNo) medicine.casNumber = row.casNo;
    medicine.sourceFiles.add(row.sourceFile);
    medicine.buyerNames.add(row.buyerName);
    if (row.annualBuyingCapacityKg !== null) {
      medicine.totalAnnualBuyingCapacityKg += row.annualBuyingCapacityKg;
    }

    const buyerKey = [
      row.productName,
      row.casNo || '',
      row.buyerName,
      row.companyCategory || '',
      row.sourceFile,
      String(row.sourceRow),
    ].join('::');
    const buyerHash = createHash('sha1').update(buyerKey).digest('hex').slice(0, 10);

    buyers.push({
      id: `buyer-${buyerHash}`,
      medicineId,
      saltId,
      productName: row.productName,
      casNo: row.casNo,
      buyerName: row.buyerName,
      companyCategory: row.companyCategory,
      certifications: row.certifications,
      annualBuyingCapacityKg: row.annualBuyingCapacityKg,
      contactPersons: row.contactPersons,
      designations: row.designations,
      emails: row.emails,
      phoneNumbers: row.phoneNumbers,
      country: row.country,
      sourceFile: row.sourceFile,
      sourceRow: row.sourceRow,
    });
  }

  const salts: SaltMasterModel[] = [...saltsByProduct.values()]
    .map((salt) => ({
      id: salt.id,
      name: salt.name,
      casNumbers: [...salt.casNumbers].sort((a, b) => a.localeCompare(b)),
      sourceFiles: [...salt.sourceFiles].sort((a, b) => a.localeCompare(b)),
      buyerCount: salt.buyerNames.size,
      totalAnnualBuyingCapacityKg: Number(salt.totalAnnualBuyingCapacityKg.toFixed(2)),
      companyCategories: [...salt.companyCategories].sort((a, b) => a.localeCompare(b)),
      countries: [...salt.countries].sort((a, b) => a.localeCompare(b)),
      certifications: [...salt.certifications].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const medicines: MedicineMasterModel[] = [...medicinesByProduct.values()]
    .map((medicine) => ({
      id: medicine.id,
      saltId: medicine.saltId,
      name: medicine.name,
      dosageForm: medicine.dosageForm,
      casNumber: medicine.casNumber,
      sourceFiles: [...medicine.sourceFiles].sort((a, b) => a.localeCompare(b)),
      buyerCount: medicine.buyerNames.size,
      totalAnnualBuyingCapacityKg: Number(medicine.totalAnnualBuyingCapacityKg.toFixed(2)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  buyers.sort((a, b) => {
    if (a.productName !== b.productName) {
      return a.productName.localeCompare(b.productName);
    }
    return a.buyerName.localeCompare(b.buyerName);
  });

  return {
    generatedAt: new Date().toISOString(),
    sourceDirectory: excelDir,
    sourceFiles,
    salts,
    medicines,
    buyers,
  };
}

export function loadMasterData(forceReload = false): MasterDataModel {
  const excelDir = resolveExcelDirectory();
  const files = listSourceFiles(excelDir);
  const signature = buildSignature(excelDir, files);
  const now = Date.now();

  if (
    !forceReload &&
    cache &&
    cache.signature === signature &&
    now - cache.loadedAt <= CACHE_MAX_AGE_MS
  ) {
    return cache.data;
  }

  const allRows: CanonicalRow[] = [];
  for (const file of files) {
    const filePath = path.join(excelDir, file);
    const rows = parseWorkbookRows(filePath, file);
    allRows.push(...rows);
  }

  if (!allRows.length) {
    throw new HttpError(
      500,
      `Master data import succeeded but produced zero rows from ${excelDir}. Check source headers and content.`
    );
  }

  const data = buildModels(allRows, excelDir, files);
  cache = {
    signature,
    loadedAt: now,
    data,
  };
  return data;
}
