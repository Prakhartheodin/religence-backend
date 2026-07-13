import mongoose from 'mongoose';
import type { EmailTemplateRecord } from '../services/email-templates.service.js';

export type EmailTemplateSet = {
  userId: string;
  templates: EmailTemplateRecord[];
  createdAt: Date;
  updatedAt: Date;
};

const templateSchema = new mongoose.Schema<EmailTemplateRecord>(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    category: { type: String, required: true, enum: ['introduction', 'follow-up', 'quotation'] },
    subject: { type: String, required: true },
    body: { type: String, required: true },
  },
  { _id: false }
);

const emailTemplateSetSchema = new mongoose.Schema<EmailTemplateSet>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    templates: { type: [templateSchema], required: true, default: [] },
  },
  {
    collection: 'email_templates',
    versionKey: false,
    timestamps: true, // real Dates, mongoose-managed (no business date here)
  }
);

export const EmailTemplateSetModel =
  mongoose.models.EmailTemplateSet ||
  mongoose.model<EmailTemplateSet>('EmailTemplateSet', emailTemplateSetSchema);
