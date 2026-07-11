import mongoose from 'mongoose';
import type { OutlookAccount } from '../types/email.js';

const OUTLOOK_ACCOUNT_STATUSES = ['active', 'revoked', 'error'] as const;

const outlookAccountSchema = new mongoose.Schema<OutlookAccount>(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    provider: { type: String, required: true, enum: ['outlook'], default: 'outlook' },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    displayName: { type: String, default: null },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, default: null },
    tokenExpiry: { type: String, default: null },
    status: { type: String, required: true, enum: OUTLOOK_ACCOUNT_STATUSES, default: 'active' },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: 'outlook_accounts',
    versionKey: false,
  }
);

outlookAccountSchema.index({ userId: 1, provider: 1, status: 1, updatedAt: -1 });

export const OutlookAccountModel =
  mongoose.models.OutlookAccount ||
  mongoose.model<OutlookAccount>('OutlookAccount', outlookAccountSchema);
