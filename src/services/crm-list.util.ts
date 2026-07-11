import { HttpError } from '../http-error.js';

// Shared validator for per-user CRM entity lists: an array of objects, each
// with a unique non-empty `id`. The rest of each item is stored verbatim
// (shapes are rich and evolving). Each entity keeps its own model + service;
// only this pure check is shared.
export function parseListItems(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'items must be an array');
  const seen = new Set<string>();
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new HttpError(400, `items[${index}] must be an object`);
    }
    const rec = item as Record<string, unknown>;
    const id = String(rec.id ?? '').trim();
    if (!id) throw new HttpError(400, `items[${index}].id is required`);
    if (seen.has(id)) throw new HttpError(400, `duplicate id: ${id}`);
    seen.add(id);
    return rec;
  });
}
