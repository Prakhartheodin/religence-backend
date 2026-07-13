import { randomUUID } from 'node:crypto';
import { OutlookAccountModel } from '../models/outlook-account.model.js';
import type { AccountStatus, OutlookAccount } from '../types/email.js';

function toOutlookAccount(doc: Partial<OutlookAccount> | null | undefined): OutlookAccount | null {
  if (!doc || !doc.id || !doc.userId || !doc.email) return null;
  return {
    id: String(doc.id),
    userId: String(doc.userId),
    provider: 'outlook',
    email: String(doc.email).toLowerCase(),
    displayName:
      doc.displayName === null || doc.displayName === undefined
        ? null
        : String(doc.displayName).trim() || null,
    accessToken: String(doc.accessToken ?? ''),
    refreshToken:
      doc.refreshToken === null || doc.refreshToken === undefined
        ? null
        : String(doc.refreshToken),
    tokenExpiry:
      doc.tokenExpiry === null || doc.tokenExpiry === undefined
        ? null
        : String(doc.tokenExpiry),
    status: (doc.status as AccountStatus) ?? 'active',
    createdAt: String(doc.createdAt ?? ''),
    updatedAt: String(doc.updatedAt ?? ''),
  };
}

export async function findOutlookAccountById(
  userId: string,
  accountId: string
): Promise<OutlookAccount | null> {
  const doc = await OutlookAccountModel.findOne({
    id: accountId,
    userId,
    provider: 'outlook',
  }).lean();
  return toOutlookAccount(doc);
}

export async function findOutlookAccountByEmail(
  userId: string,
  email: string
): Promise<OutlookAccount | null> {
  const target = email.toLowerCase();
  const doc = await OutlookAccountModel.findOne({
    userId,
    provider: 'outlook',
    email: target,
    status: { $ne: 'revoked' },
  })
    .sort({ updatedAt: -1 })
    .lean();
  return toOutlookAccount(doc);
}

export async function findActiveOutlookAccountsByUser(
  userId: string
): Promise<OutlookAccount[]> {
  const docs = await OutlookAccountModel.find({
    userId,
    provider: 'outlook',
    status: 'active',
  })
    .sort({ updatedAt: -1 })
    .lean();

  return docs
    .map((doc) => toOutlookAccount(doc))
    .filter((a): a is OutlookAccount => Boolean(a));
}

export async function upsertOutlookAccount(input: {
  userId: string;
  email: string;
  displayName?: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: string | null;
}): Promise<OutlookAccount> {
  const email = input.email.toLowerCase();
  const existing = await findOutlookAccountByEmail(input.userId, email);
  const now = new Date().toISOString();

  const displayName = input.displayName?.trim() || null;

  if (existing) {
    const updated = await OutlookAccountModel.findOneAndUpdate(
      { id: existing.id },
      {
        $set: {
          email,
          displayName: displayName ?? existing.displayName ?? null,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          tokenExpiry: input.tokenExpiry,
          status: 'active',
          updatedAt: now,
        },
      },
      { returnDocument: 'after', lean: true }
    );
    const next = toOutlookAccount(updated);
    if (!next) throw new Error('Failed to update Outlook account document');
    return next;
  }

  const created: OutlookAccount = {
    id: randomUUID(),
    userId: input.userId,
    provider: 'outlook',
    email,
    displayName,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiry: input.tokenExpiry,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await OutlookAccountModel.create(created);
  return created;
}

export async function updateOutlookAccount(
  userId: string,
  accountId: string,
  patch: Partial<OutlookAccount>
): Promise<OutlookAccount | null> {
  const updated = await OutlookAccountModel.findOneAndUpdate(
    { id: accountId, userId, provider: 'outlook' },
    {
      $set: {
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    },
    { returnDocument: 'after', lean: true }
  );
  return toOutlookAccount(updated);
}

export async function setOutlookAccountStatus(
  userId: string,
  accountId: string,
  status: AccountStatus
): Promise<OutlookAccount | null> {
  return updateOutlookAccount(userId, accountId, { status });
}
