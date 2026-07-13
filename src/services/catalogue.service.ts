import { HttpError } from '../http-error.js';
import { MedicineCatalogue, SaltCatalogue } from '../models/catalogue.js';

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

export async function listSalts(): Promise<Record<string, unknown>[]> {
  const docs = await SaltCatalogue.find({}).sort({ name: 1 });
  return docs.map((d) => d.toJSON());
}

export async function createSalt(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = str(body.id);
  const name = str(body.name);
  if (!id) throw new HttpError(400, 'id is required');
  if (!name) throw new HttpError(400, 'name is required');
  if (await SaltCatalogue.exists({ id })) throw new HttpError(409, `salt ${id} already exists`);
  const doc = await SaltCatalogue.create({ id, name });
  return doc.toJSON();
}

export async function updateSalt(
  id: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const set: Record<string, string> = {};
  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name) throw new HttpError(400, 'name cannot be empty');
    set.name = name;
  }
  const doc = await SaltCatalogue.findOneAndUpdate(
    { id },
    { $set: set },
    { returnDocument: 'after', runValidators: true }
  );
  if (!doc) throw new HttpError(404, `salt ${id} not found`);
  return doc.toJSON();
}

export async function deleteSalt(id: string): Promise<void> {
  // The only referential link in the catalogue. Leads point at salts by NAME,
  // not id, so there is nothing else to check.
  if (await MedicineCatalogue.exists({ saltId: id })) {
    throw new HttpError(409, 'salt has linked medicines');
  }
  const res = await SaltCatalogue.deleteOne({ id });
  if (!res.deletedCount) throw new HttpError(404, `salt ${id} not found`);
}

export async function listMedicines(): Promise<Record<string, unknown>[]> {
  const docs = await MedicineCatalogue.find({}).sort({ name: 1 });
  return docs.map((d) => d.toJSON());
}

export async function createMedicine(
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = str(body.id);
  const name = str(body.name);
  const saltId = str(body.saltId);
  const dosageForm = str(body.dosageForm) || 'API';
  if (!id) throw new HttpError(400, 'id is required');
  if (!name) throw new HttpError(400, 'name is required');
  if (!saltId) throw new HttpError(400, 'saltId is required');
  if (!(await SaltCatalogue.exists({ id: saltId }))) {
    throw new HttpError(400, `unknown saltId: ${saltId}`);
  }
  if (await MedicineCatalogue.exists({ id })) {
    throw new HttpError(409, `medicine ${id} already exists`);
  }
  const doc = await MedicineCatalogue.create({ id, saltId, name, dosageForm });
  return doc.toJSON();
}

export async function updateMedicine(
  id: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const set: Record<string, string> = {};
  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name) throw new HttpError(400, 'name cannot be empty');
    set.name = name;
  }
  if (body.dosageForm !== undefined) set.dosageForm = str(body.dosageForm) || 'API';
  if (body.saltId !== undefined) {
    const saltId = str(body.saltId);
    if (!(await SaltCatalogue.exists({ id: saltId }))) {
      throw new HttpError(400, `unknown saltId: ${saltId}`);
    }
    set.saltId = saltId;
  }
  const doc = await MedicineCatalogue.findOneAndUpdate(
    { id },
    { $set: set },
    { returnDocument: 'after', runValidators: true }
  );
  if (!doc) throw new HttpError(404, `medicine ${id} not found`);
  return doc.toJSON();
}

export async function deleteMedicine(id: string): Promise<void> {
  const res = await MedicineCatalogue.deleteOne({ id });
  if (!res.deletedCount) throw new HttpError(404, `medicine ${id} not found`);
}
