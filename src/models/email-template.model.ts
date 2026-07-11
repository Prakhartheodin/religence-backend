import mongoose from 'mongoose';
import type { EmailTemplateRecord } from '../services/email-templates.service.js';

export type EmailTemplateSet = {
  userId: string;
  templates: EmailTemplateRecord[];
  createdAt: string;
  updatedAt: string;
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
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: 'email_templates',
    versionKey: false,
  }
);

export const EmailTemplateSetModel =
  mongoose.models.EmailTemplateSet ||
  mongoose.model<EmailTemplateSet>('EmailTemplateSet', emailTemplateSetSchema);
