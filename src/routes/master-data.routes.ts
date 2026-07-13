import { Router, type Request } from 'express';
import * as catalogue from '../services/catalogue.service.js';
import { clearMasterDataCache, loadMasterData } from '../services/master-data.service.js';

export const masterDataRouter = Router();

// requireAuth (mounted in index.ts) sets req.userId; used as the change-log actor.
const uid = (req: Request): string =>
  (req as Request & { userId?: string }).userId ?? '';

/**
 * The salt/medicine catalogue is a single SHARED table — no userId, one row per
 * salt. Per-item writes only.
 *
 * These used to be "per-user lists like any CRM entity", routed through crmList().
 * That gave every user a private copy of the same 10 Excel-derived rows, and its
 * whole-array PUT ran deleteMany({ id: { $nin: sentIds } }) — so a PUT of []
 * wiped the catalogue, which is what the settings "Reset all" button did. There
 * is no PUT here and it is not coming back.
 *
 * requireAuth gates this router in index.ts, so reads need a login. Writes are
 * global by design: one team, one catalogue.
 */

masterDataRouter.get('/salts', async (_req, res, next) => {
  try {
    res.json(await catalogue.listSalts());
  } catch (err) {
    next(err);
  }
});

masterDataRouter.post('/salts', async (req, res, next) => {
  try {
    res.status(201).json(await catalogue.createSalt(req.body ?? {}, uid(req)));
  } catch (err) {
    next(err);
  }
});

masterDataRouter.patch('/salts/:id', async (req, res, next) => {
  try {
    res.json(await catalogue.updateSalt(req.params.id, req.body ?? {}, uid(req)));
  } catch (err) {
    next(err);
  }
});

masterDataRouter.delete('/salts/:id', async (req, res, next) => {
  try {
    await catalogue.deleteSalt(req.params.id, uid(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

masterDataRouter.get('/medicines', async (_req, res, next) => {
  try {
    res.json(await catalogue.listMedicines());
  } catch (err) {
    next(err);
  }
});

masterDataRouter.post('/medicines', async (req, res, next) => {
  try {
    res.status(201).json(await catalogue.createMedicine(req.body ?? {}, uid(req)));
  } catch (err) {
    next(err);
  }
});

masterDataRouter.patch('/medicines/:id', async (req, res, next) => {
  try {
    res.json(await catalogue.updateMedicine(req.params.id, req.body ?? {}, uid(req)));
  } catch (err) {
    next(err);
  }
});

masterDataRouter.delete('/medicines/:id', async (req, res, next) => {
  try {
    await catalogue.deleteMedicine(req.params.id, uid(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Buyers live in MongoDB (seeded from Excel via scripts/seed-buyers-from-excel.mts).
// Lead Discovery joins buyers against the deterministic salt-<slug> / med-<slug> ids.
masterDataRouter.get('/', async (req, res, next) => {
  try {
    const forceReload = String(req.query.reload || '').toLowerCase() === 'true';
    if (forceReload) clearMasterDataCache();
    res.json(await loadMasterData(forceReload));
  } catch (err) {
    next(err);
  }
});

masterDataRouter.post('/reload', async (_req, res, next) => {
  try {
    clearMasterDataCache();
    res.json(await loadMasterData(true));
  } catch (err) {
    next(err);
  }
});
