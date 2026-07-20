import mongoose from 'mongoose';

/**
 * One document per CRM item (per lead, per contact, ...) rather than one
 * array-of-Mixed per user. Fields are typed, so Mongo casts and validates on
 * write and dates are real Dates — queryable, sortable, aggregatable.
 */

const sourceLink = new mongoose.Schema(
  { label: { type: String, default: '' }, url: { type: String, default: '' } },
  { _id: false }
);

/** Calendar fields ("2026-07-18") stored as Date, handed back as YYYY-MM-DD. */
const ymd = (d: unknown): string | undefined =>
  d instanceof Date ? d.toISOString().slice(0, 10) : undefined;

type EntitySpec = {
  collection: string;
  fields: Record<string, unknown>;
  /** Date fields the client sends/expects as YYYY-MM-DD, not a timestamp. */
  calendar?: string[];
};

function entityModel(name: string, spec: EntitySpec): mongoose.Model<Record<string, unknown>> {
  const schema = new mongoose.Schema(
    {
      userId: { type: String, required: true },
      id: { type: String, required: true },
      // The client sends an ordered array (timeline is newest-first); documents
      // have no inherent order, so the array index is stored to preserve it.
      _order: { type: Number, required: true, default: 0 },
      ...spec.fields,
    },
    {
      collection: spec.collection,
      versionKey: false,
      // No mongoose timestamps: several entities carry their own business
      // `createdAt` (a calendar date), which auto-timestamps would overwrite.
      toJSON: {
        transform(_doc, ret: Record<string, unknown>) {
          delete ret._id;
          delete ret.userId;
          delete ret._order;
          for (const f of spec.calendar ?? []) {
            if (ret[f] != null) ret[f] = ymd(ret[f]);
          }
          return ret;
        },
      },
    }
  );
  // One item id per user; also the lookup index for every read.
  schema.index({ userId: 1, id: 1 }, { unique: true });
  schema.index({ userId: 1, _order: 1 });
  return (mongoose.models[name] ||
    mongoose.model(name, schema)) as mongoose.Model<Record<string, unknown>>;
}

export const LEAD_STAGES = [
  'Saved',
  'Verified',
  'Intro Email Sent',
  'Follow-up Sent',
  'Replied',
  'Sample Requested',
  'Quotation Sent',
  'Negotiation',
  'Won',
  'Lost',
  'Dormant',
] as const;

export const CrmEntities = {
  companies: entityModel('Company', {
    collection: 'companies',
    calendar: ['createdAt'],
    fields: {
      name: { type: String, default: '' },
      location: { type: String, default: '' },
      website: { type: String, default: '' },
      companyType: { type: String, default: '' },
      certification: { type: String, default: '' },
      city: { type: String, default: '' },
      country: { type: String, default: '' },
      gstin: { type: String, default: '' },
      pan: { type: String, default: '' },
      discoveryCompanyId: { type: String },
      sourceLinks: { type: [sourceLink], default: [] },
      createdAt: { type: Date },
    },
  }),

  contacts: entityModel('Contact', {
    collection: 'contacts',
    calendar: ['createdAt'],
    fields: {
      companyId: { type: String, default: '' },
      name: { type: String, default: '' },
      role: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String },
      createdAt: { type: Date },
    },
  }),

  leads: entityModel('Lead', {
    collection: 'leads',
    calendar: ['followUpDate', 'lastContactDate', 'lastActivity', 'createdAt'],
    fields: {
      title: { type: String, default: '' },
      companyId: { type: String, default: '' },
      contactId: { type: String, default: null },
      discoveryCompanyId: { type: String },
      companyName: { type: String, default: '' },
      contactName: { type: String, default: '' },
      contactRole: { type: String, default: '' },
      contactEmail: { type: String, default: '' },
      matchedSalt: { type: String, default: '' },
      matchedMedicine: { type: String, default: '' },
      saltId: { type: String, default: '' },
      medicineId: { type: String, default: '' },
      medicineIds: { type: [String], default: [] },
      dosageForm: { type: String, default: '' },
      location: { type: String, default: '' },
      stage: { type: String, enum: LEAD_STAGES, default: 'Saved' },
      leadScore: { type: Number, default: 0, min: 0 },
      assignedTo: { type: String, default: '' },
      marketTier: { type: String, default: '' },
      segment: { type: String, default: '' },
      leadSource: { type: String, default: '' },
      priority: { type: String, default: '' },
      qualScore: { type: Number, default: 0, min: 0, max: 25 },
      potentialQty: { type: String, default: '' },
      estAnnualValue: { type: String, default: '' },
      lastContactDate: { type: Date },
      followUpDate: { type: Date },
      nextAction: { type: String, default: '' },
      docsShared: { type: String, default: '' },
      lastDiscussionSummary: { type: String, default: '' },
      lastActivity: { type: Date },
      notes: { type: String, default: '' },
      createdAt: { type: Date },
      sourceLinks: { type: [sourceLink], default: [] },
    },
  }),

  deals: entityModel('Deal', {
    collection: 'deals',
    calendar: ['createdAt'],
    fields: {
      leadId: { type: String, default: '' },
      title: { type: String, default: '' },
      companyName: { type: String, default: '' },
      // Free text ("$40k", "TBD") in the UI — not a number. Left as String.
      value: { type: String, default: '' },
      stage: { type: String, enum: ['Open', 'Won', 'Lost'], default: 'Open' },
      createdAt: { type: Date },
    },
  }),

  timeline: entityModel('Timeline', {
    collection: 'crm_timeline',
    calendar: ['date'],
    fields: {
      leadId: { type: String, default: '' },
      date: { type: Date },
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      type: {
        type: String,
        enum: ['stage', 'email', 'note', 'call', 'verification', 'deal'],
        default: 'note',
      },
    },
  }),

  emails: entityModel('EmailMeta', {
    collection: 'crm_emails',
    fields: {
      leadId: { type: String, default: null },
      starred: { type: Boolean, default: false },
      read: { type: Boolean, default: false },
      archived: { type: Boolean, default: false },
      trashed: { type: Boolean, default: false },
    },
  }),

  // One document per sample dispatched to a lead's company.
  samples: entityModel('Sample', {
    collection: 'samples',
    calendar: ['dispatchDate', 'createdAt'],
    fields: {
      leadId: { type: String, default: '' },
      companyId: { type: String, default: '' },
      companyName: { type: String, default: '' },
      productId: { type: String, default: '' },
      product: { type: String, default: '' },
      qty: { type: String, default: '' },
      batchNo: { type: String, default: '' },
      // Free text status set by the UI (Requested / Dispatched / ...); no enum
      // so a new client status can't 400 the whole save.
      status: { type: String, default: 'Requested' },
      dispatchDate: { type: Date },
      courier: { type: String, default: '' },
      awb: { type: String, default: '' },
      coaSent: { type: Boolean, default: false },
      feedback: { type: String, default: '' },
      owner: { type: String, default: '' },
      createdAt: { type: Date },
    },
  }),

  quotations: entityModel('Quotation', {
    collection: 'quotations',
    calendar: ['quoteDate', 'validUntil', 'createdAt'],
    fields: {
      leadId: { type: String, default: '' },
      companyId: { type: String, default: '' },
      companyName: { type: String, default: '' },
      owner: { type: String, default: '' },
      quoteNo: { type: String, default: '' },
      quoteDate: { type: Date },
      productId: { type: String, default: '' },
      product: { type: String, default: '' },
      casNo: { type: String, default: '' },
      hsnSac: { type: String, default: '' },
      qty: { type: String, default: '' },
      unitPrice: { type: String, default: '' },
      currency: { type: String, default: 'INR' },
      gstRate: { type: String, default: '' },
      priceBasis: { type: String, default: '' },
      validUntil: { type: Date },
      status: { type: String, default: 'Draft' },
      note: { type: String, default: '' },
      subTotal: { type: Number, default: 0 },
      gstAmount: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
      createdAt: { type: Date },
    },
  }),

  // Salts and medicines are NOT here: they are a shared catalogue, not per-user
  // lists. See models/catalogue.ts. Routing them through this per-user machinery
  // is what gave every user a private copy of the same 10 rows.
} as const;

export type CrmEntityName = keyof typeof CrmEntities;
