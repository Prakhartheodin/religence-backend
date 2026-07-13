import { Router, type Request } from 'express';
import { loadMasterData } from '../services/master-data.service.js';
import { crmList } from '../services/crm-list.service.js';

export const masterDataRouter = Router();

// requireAuth (mounted in index.ts) sets req.userId from the verified JWT.
function uid(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? '';
}

// Salts/medicines are per-user lists like any CRM entity; same storage, same
// GET/PUT contract. They keep their own collections rather than one keyed blob.
for (const kind of ['salts', 'medicines'] as const) {
  const service = crmList(kind);
  masterDataRouter.get(`/${kind}`, async (req, res, next) => {
    try {
      res.json(await service.get(uid(req)));
    } catch (err) {
      next(err);
    }
  });
  masterDataRouter.put(`/${kind}`, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body) ? req.body : req.body?.items;
      res.json(await service.replace(uid(req), items));
    } catch (err) {
      next(err);
    }
  });
}

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
