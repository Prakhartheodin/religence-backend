import { HttpError } from '../http-error.js';
import { buildMasterDataFromBuyers } from '../lib/excel-master-data.js';
import { countBuyers, listBuyers } from './buyer.service.js';
import type { MasterDataModel } from '../types/master-data.js';

const CACHE_MAX_AGE_MS = 60_000;

let cache: {
  buyerCount: number;
  loadedAt: number;
  data: MasterDataModel;
} | null = null;

export async function loadMasterData(forceReload = false): Promise<MasterDataModel> {
  const now = Date.now();
  const buyerCount = await countBuyers();

  if (buyerCount === 0) {
    throw new HttpError(
      500,
      'No buyers in MongoDB. Run `npx tsx scripts/seed-buyers-from-excel.mts --apply` to import from Excel.'
    );
  }

  if (
    !forceReload &&
    cache &&
    cache.buyerCount === buyerCount &&
    now - cache.loadedAt <= CACHE_MAX_AGE_MS
  ) {
    return cache.data;
  }

  const buyers = await listBuyers();
  const sourceFiles = [...new Set(buyers.map((b) => b.sourceFile))].sort((a, b) =>
    a.localeCompare(b)
  );

  const data = buildMasterDataFromBuyers(buyers, {
    sourceDirectory: 'mongodb://buyers',
    sourceFiles,
  });

  cache = {
    buyerCount,
    loadedAt: now,
    data,
  };
  return data;
}

export function clearMasterDataCache(): void {
  cache = null;
}
