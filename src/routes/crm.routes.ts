import { Router, type Request } from 'express';
import { crmList } from '../services/crm-list.service.js';

export const crmRouter = Router();

// requireAuth (mounted in index.ts) sets req.userId from the verified JWT.
function uid(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? '';
}

// path -> [mongoose model name, collection]. Adding an entity is one line.
const ENTITIES: Record<string, [string, string]> = {
  contacts: ['Contact', 'contacts'],
  companies: ['Company', 'companies'],
  leads: ['Lead', 'leads'],
  deals: ['Deal', 'deals'],
  timeline: ['Timeline', 'crm_timeline'],
  emails: ['Email', 'crm_emails'],
};

for (const [path, [name, collection]] of Object.entries(ENTITIES)) {
  const service = crmList(name, collection);
  crmRouter.get(`/${path}`, async (req, res, next) => {
    try {
      res.json(await service.get(uid(req)));
    } catch (err) {
      next(err);
    }
  });
  crmRouter.put(`/${path}`, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body) ? req.body : req.body?.items;
      res.json(await service.replace(uid(req), items));
    } catch (err) {
      next(err);
    }
  });
}
