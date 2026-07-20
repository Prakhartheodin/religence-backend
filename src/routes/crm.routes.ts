import { Router, type Request } from 'express';
import { crmList } from '../services/crm-list.service.js';
import type { CrmEntityName } from '../models/crm-entities.js';

export const crmRouter = Router();

// requireAuth (mounted in index.ts) sets req.userId from the verified JWT.
function uid(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? '';
}

const ENTITIES: CrmEntityName[] = [
  'contacts',
  'companies',
  'leads',
  'deals',
  'timeline',
  'emails',
  'samples',
  'quotations',
];

for (const entity of ENTITIES) {
  const service = crmList(entity);
  crmRouter.get(`/${entity}`, async (req, res, next) => {
    try {
      res.json(await service.get(uid(req)));
    } catch (err) {
      next(err);
    }
  });
  crmRouter.put(`/${entity}`, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body) ? req.body : req.body?.items;
      const baseIds = Array.isArray(req.body?.baseIds)
        ? (req.body.baseIds as unknown[]).map(String)
        : null;
      res.json(await service.replace(uid(req), items, baseIds));
    } catch (err) {
      next(err);
    }
  });
}
