import { Router, type Request } from 'express';
import { loadMasterData } from '../services/master-data.service.js';
import { getMasterList, replaceMasterList } from '../services/master-list.service.js';
import type { MasterListKind } from '../models/master-list.model.js';

export const masterDataRouter = Router();

// requireAuth (mounted in index.ts) sets req.userId from the verified JWT.
function uid(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? '';
}

function registerListRoutes(kind: MasterListKind): void {
  masterDataRouter.get(`/${kind}`, async (req, res, next) => {
    try {
      res.json(await getMasterList(uid(req), kind));
    } catch (err) {
      next(err);
    }
  });
  masterDataRouter.put(`/${kind}`, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body) ? req.body : req.body?.items;
      res.json(await replaceMasterList(uid(req), kind, items));
    } catch (err) {
      next(err);
    }
  });
}

registerListRoutes('salts');
registerListRoutes('medicines');

masterDataRouter.get('/', (req, res, next) => {
  try {
    const forceReload =
      String(req.query.reload || '').toLowerCase() === 'true';
    const data = loadMasterData(forceReload);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

masterDataRouter.post('/reload', (_req, res, next) => {
  try {
    const data = loadMasterData(true);
    res.json(data);
  } catch (err) {
    next(err);
  }
});
