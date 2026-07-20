import { AuthTokenModel, type AuthTokenPurpose } from '../models/auth-token.model.js';
import { UserModel, type UserDoc } from '../models/user.model.js';

export type User = UserDoc;

export type OneTimeToken = {
  tokenHash: string;
  userId: string;
  purpose: Extract<AuthTokenPurpose, 'verify' | 'reset'>;
  expiresAt: Date;
};

const norm = (email: string): string => email.trim().toLowerCase();

export async function findByEmail(email: string): Promise<User | null> {
  return UserModel.findOne({ email: norm(email) }).lean<User>();
}

export async function findById(userId: string): Promise<User | null> {
  return UserModel.findOne({ userId }).lean<User>();
}

/** Internal Religence users eligible as lead assignees (not CRM contacts). */
export async function listTeamMemberNames(): Promise<string[]> {
  const users = await UserModel.find({})
    .sort({ name: 1 })
    .select('name')
    .lean<Pick<User, 'name'>[]>();
  const names = users.map((u) => u.name.trim()).filter(Boolean);
  return [...new Set(names)];
}

export async function createUser(u: User): Promise<User> {
  await UserModel.create(u);
  return u;
}

export async function updateUser(userId: string, patch: Partial<User>): Promise<void> {
  await UserModel.updateOne({ userId }, { $set: patch });
}

export async function addToken(t: OneTimeToken): Promise<void> {
  await AuthTokenModel.create(t);
}

/** Single-use: removes any matching hash, returns userId if valid+unexpired. */
export async function consumeToken(
  tokenHash: string,
  purpose: OneTimeToken['purpose']
): Promise<string | null> {
  const tok = await AuthTokenModel.findOneAndDelete({ tokenHash, purpose }).lean<OneTimeToken>();
  if (!tok) return null;
  return tok.expiresAt.getTime() < Date.now() ? null : tok.userId;
}

const CONSUMED_VERIFY_TTL_MS = 24 * 3600 * 1000;

/** Remember a consumed verify token so duplicate requests still succeed. */
export async function recordConsumedVerify(tokenHash: string, userId: string): Promise<void> {
  await AuthTokenModel.updateOne(
    { tokenHash, purpose: 'verify-consumed' },
    { $set: { userId, expiresAt: new Date(Date.now() + CONSUMED_VERIFY_TTL_MS) } },
    { upsert: true }
  );
}

/** Returns userId if this verify token was recently consumed successfully. */
export async function findConsumedVerify(tokenHash: string): Promise<string | null> {
  const entry = await AuthTokenModel.findOne({
    tokenHash,
    purpose: 'verify-consumed',
  }).lean<OneTimeToken>();
  if (!entry || entry.expiresAt.getTime() < Date.now()) return null;
  return entry.userId;
}
