import { Router, type Request } from 'express';
import { getContacts, replaceContacts } from '../services/contact.service.js';
import { getCompanies, replaceCompanies } from '../services/company.service.js';
import { getLeads, replaceLeads } from '../services/lead.service.js';
import { getDeals, replaceDeals } from '../services/deal.service.js';
import { getTimeline, replaceTimeline } from '../services/timeline.service.js';

export const crmRouter = Router();

// requireAuth (mounted in index.ts) sets req.userId from the verified JWT.
function uid(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? '';
}

type ListService = {
  get: (userId: string) => Promise<Record<string, unknown>[]>;
  replace: (userId: string, input: unknown) => Promise<Record<string, unknown>[]>;
};

// Each entity keeps its own model + service; the router just exposes them
// under a consistent GET/PUT /v1/crm/<entity> surface.
function registerEntity(path: string, service: ListService): void {
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

registerEntity('contacts', { get: getContacts, replace: replaceContacts });
registerEntity('companies', { get: getCompanies, replace: replaceCompanies });
registerEntity('leads', { get: getLeads, replace: replaceLeads });
registerEntity('deals', { get: getDeals, replace: replaceDeals });
registerEntity('timeline', { get: getTimeline, replace: replaceTimeline });
