import { HttpError } from '../http-error.js';
import { MedicineCatalogue, SaltCatalogue } from '../models/catalogue.js';
import { recordChanges } from './change-log.service.js';

/**
 * Shared salt/medicine catalogue. Per-item writes only.
 *
 * There is deliberately NO replace()/whole-array PUT. The old one ran
 * deleteMany({ id: { $nin: sentIds } }), so a PUT of [] deleted the entire
 * catalogue — which the settings page's "Reset all" button did, by accident.
 *
 * ponytail: last-write-wins on concurrent edits. Two people renaming the same
 * salt at once is not worth a version column for a single team.
 */

const str = (v: unknown): string => String(v ?? '').trim();

/** Dedupe, trim, and confirm every salt id exists. Throws 400 on an unknown id. */
async function validateSaltIds(raw: unknown): Promise<string[]> {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(str).filter(Boolean))];
  for (const saltId of ids) {
    if (!(await SaltCatalogue.exists({ id: saltId }))) {
      throw new HttpError(400, `unknown saltId: ${saltId}`);
    }
  }
  return ids;
}

export async function listSalts(): Promise<Record<string, unknown>[]> {
  const docs = await SaltCatalogue.find({}).sort({ name: 1 });
  return docs.map((d) => d.toJSON());
}

export async function createSalt(
  body: Record<string, unknown>,
  actorUserId = ''
): Promise<Record<string, unknown>> {
  const id = str(body.id);
  const name = str(body.name);
  if (!id) throw new HttpError(400, 'id is required');
  if (!name) throw new HttpError(400, 'name is required');
  if (await SaltCatalogue.exists({ id })) throw new HttpError(409, `salt ${id} already exists`);
  const doc = await SaltCatalogue.create({ id, name });
  const json = doc.toJSON();
  await recordChanges([{ actorUserId, entity: 'salts', docId: id, op: 'create', before: null, after: json }]);
  return json;
}

export async function updateSalt(
  id: string,
  body: Record<string, unknown>,
  actorUserId = ''
): Promise<Record<string, unknown>> {
  const set: Record<string, string> = {};
  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name) throw new HttpError(400, 'name cannot be empty');
    set.name = name;
  }
  const before = await SaltCatalogue.findOne({ id });
  if (!before) throw new HttpError(404, `salt ${id} not found`);
  const doc = await SaltCatalogue.findOneAndUpdate(
    { id },
    { $set: set },
    { returnDocument: 'after', runValidators: true }
  );
  if (!doc) throw new HttpError(404, `salt ${id} not found`);
  const json = doc.toJSON();
  await recordChanges([
    { actorUserId, entity: 'salts', docId: id, op: 'update', before: before.toJSON(), after: json },
  ]);
  return json;
}

export async function deleteSalt(id: string, actorUserId = ''): Promise<void> {
  // The only referential link in the catalogue. Leads point at salts by NAME,
  // not id, so there is nothing else to check. Match both shapes so an
  // un-migrated `saltId` doc still blocks the delete.
  if (await MedicineCatalogue.exists({ $or: [{ saltIds: id }, { saltId: id }] })) {
    throw new HttpError(409, 'salt has linked medicines');
  }
  const before = await SaltCatalogue.findOne({ id });
  if (!before) throw new HttpError(404, `salt ${id} not found`);
  await SaltCatalogue.deleteOne({ id });
  await recordChanges([
    { actorUserId, entity: 'salts', docId: id, op: 'delete', before: before.toJSON(), after: null },
  ]);
}

/**
 * Idempotent bulk upsert used by the Excel import. Keyed by the deterministic
 * salt-<slug> id so re-importing is a no-op. Uses $setOnInsert for name so a
 * salt a user has since renamed in the master page is NOT reset by re-import.
 */
export async function upsertSalts(
  salts: { id: string; name: string }[]
): Promise<{ upserted: number; matched: number }> {
  if (!salts.length) return { upserted: 0, matched: 0 };
  const ops = salts.map((s) => ({
    updateOne: {
      filter: { id: s.id },
      update: { $setOnInsert: { id: s.id, name: s.name } },
      upsert: true,
    },
  }));
  const r = await SaltCatalogue.bulkWrite(ops, { ordered: false });
  return { upserted: r.upsertedCount, matched: r.matchedCount };
}

/** Idempotent bulk upsert of medicines. Salts must be upserted first (saltIds FK). */
export async function upsertMedicines(
  medicines: { id: string; saltIds: string[]; name: string; dosageForm: string }[]
): Promise<{ upserted: number; matched: number }> {
  if (!medicines.length) return { upserted: 0, matched: 0 };
  const ops = medicines.map((m) => ({
    updateOne: {
      filter: { id: m.id },
      update: {
        $setOnInsert: {
          id: m.id,
          saltIds: m.saltIds,
          name: m.name,
          dosageForm: m.dosageForm || 'API',
        },
      },
      upsert: true,
    },
  }));
  const r = await MedicineCatalogue.bulkWrite(ops, { ordered: false });
  return { upserted: r.upsertedCount, matched: r.matchedCount };
}

export async function listMedicines(): Promise<Record<string, unknown>[]> {
  const docs = await MedicineCatalogue.find({}).sort({ name: 1 });
  return docs.map((d) => d.toJSON());
}

export async function createMedicine(
  body: Record<string, unknown>,
  actorUserId = ''
): Promise<Record<string, unknown>> {
  const id = str(body.id);
  const name = str(body.name);
  const saltIds = await validateSaltIds(body.saltIds);
  const dosageForm = str(body.dosageForm) || 'API';
  if (!id) throw new HttpError(400, 'id is required');
  if (!name) throw new HttpError(400, 'name is required');
  if (!saltIds.length) throw new HttpError(400, 'at least one saltId is required');
  if (await MedicineCatalogue.exists({ id })) {
    throw new HttpError(409, `medicine ${id} already exists`);
  }
  const doc = await MedicineCatalogue.create({ id, saltIds, name, dosageForm });
  const json = doc.toJSON();
  await recordChanges([
    { actorUserId, entity: 'medicines', docId: id, op: 'create', before: null, after: json },
  ]);
  return json;
}

export async function updateMedicine(
  id: string,
  body: Record<string, unknown>,
  actorUserId = ''
): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name) throw new HttpError(400, 'name cannot be empty');
    set.name = name;
  }
  if (body.dosageForm !== undefined) set.dosageForm = str(body.dosageForm) || 'API';
  if (body.saltIds !== undefined) {
    const saltIds = await validateSaltIds(body.saltIds);
    if (!saltIds.length) throw new HttpError(400, 'at least one saltId is required');
    set.saltIds = saltIds;
  }
  const before = await MedicineCatalogue.findOne({ id });
  if (!before) throw new HttpError(404, `medicine ${id} not found`);
  const doc = await MedicineCatalogue.findOneAndUpdate(
    { id },
    { $set: set },
    { returnDocument: 'after', runValidators: true }
  );
  if (!doc) throw new HttpError(404, `medicine ${id} not found`);
  const json = doc.toJSON();
  await recordChanges([
    { actorUserId, entity: 'medicines', docId: id, op: 'update', before: before.toJSON(), after: json },
  ]);
  return json;
}

export async function deleteMedicine(id: string, actorUserId = ''): Promise<void> {
  const before = await MedicineCatalogue.findOne({ id });
  if (!before) throw new HttpError(404, `medicine ${id} not found`);
  await MedicineCatalogue.deleteOne({ id });
  await recordChanges([
    { actorUserId, entity: 'medicines', docId: id, op: 'delete', before: before.toJSON(), after: null },
  ]);
}
