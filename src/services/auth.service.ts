import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config.js';
import { HttpError } from '../http-error.js';
import * as store from './auth-store.js';
import { sendPasswordReset, sendVerification } from './mailer.js';

const ITERATIONS = 600_000; // OWASP floor for PBKDF2-SHA256
const TOKEN_TTL_S = 24 * 3600;
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function secret(): string {
  if (!config.jwtSecret) throw new HttpError(503, 'AUTH_JWT_SECRET is not set');
  return config.jwtSecret;
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')): {
  hash: string;
  salt: string;
} {
  const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('base64');
  return { hash, salt };
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  const computed = Buffer.from(hashPassword(password, salt).hash, 'base64');
  const stored = Buffer.from(hash, 'base64');
  // timingSafeEqual throws on length mismatch; a wrong-length stored hash is a
  // non-match, not a crash.
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

const tokenHash = (raw: string): string => createHash('sha256').update(raw).digest('hex');

async function issueToken(
  userId: string,
  purpose: 'verify' | 'reset',
  ttlMs: number
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await store.addToken({
    tokenHash: tokenHash(raw),
    userId,
    purpose,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

function issueJwt(userId: string): string {
  return jwt.sign({}, secret(), {
    subject: userId,
    expiresIn: TOKEN_TTL_S,
    issuer: 'religence-auth',
    audience: 'religence-api',
  });
}

export function verifyJwt(token: string): string {
  const payload = jwt.verify(token, secret(), {
    algorithms: ['HS256'],
    issuer: 'religence-auth',
    audience: 'religence-api',
  }) as jwt.JwtPayload;
  if (!payload.sub) throw new Error('no subject');
  return payload.sub;
}

/** Short-lived token tying an Outlook OAuth flow to a specific JWT user. */
export function issueOutlookConnectToken(userId: string): string {
  return jwt.sign({ purpose: 'outlook-connect' }, secret(), {
    subject: userId,
    expiresIn: '10m',
    issuer: 'religence-auth',
    audience: 'religence-oauth',
  });
}

export function verifyOutlookConnectToken(token: string): string {
  const payload = jwt.verify(token, secret(), {
    algorithms: ['HS256'],
    issuer: 'religence-auth',
    audience: 'religence-oauth',
  }) as jwt.JwtPayload & { purpose?: string };
  if (payload.purpose !== 'outlook-connect' || !payload.sub) {
    throw new HttpError(401, 'invalid or expired connect token');
  }
  return payload.sub;
}

function requireStrong(password: string): void {
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(422, 'password must be at least 8 characters with a letter and a number');
  }
}

function requireName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new HttpError(422, 'name is required');
  return normalized;
}

// ponytail: in-memory login throttle, single-process. Move to a shared store
// if the backend ever runs multiple instances.
const attempts = new Map<string, number[]>();
function throttle(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const hits = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) throw new HttpError(429, 'too many requests');
  hits.push(now);
  attempts.set(key, hits);
}

export async function register(
  name: string,
  email: string,
  password: string,
  confirmPassword: string
): Promise<void> {
  const cleanName = requireName(name);
  if (!password) throw new HttpError(422, 'password is required');
  if (!confirmPassword) throw new HttpError(422, 'confirm password is required');
  if (password !== confirmPassword) throw new HttpError(422, 'password and confirm password must match');
  if (!EMAIL_RE.test(email.trim())) throw new HttpError(422, 'invalid email address');
  requireStrong(password);
  if (await store.findByEmail(email)) {
    throw new HttpError(409, 'an account with this email already exists');
  }
  const { hash, salt } = hashPassword(password);
  const user = await store.createUser({
    userId: `usr-${randomUUID()}`,
    email: email.trim().toLowerCase(),
    name: cleanName,
    passwordHash: hash,
    passwordSalt: salt,
    emailVerified: false,
    createdAt: new Date(),
  });
  await sendVerification(user.email, await issueToken(user.userId, 'verify', VERIFY_TTL_MS));
}

export async function verifyEmail(raw: string): Promise<void> {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new HttpError(400, 'invalid or expired verification token');

  const hash = tokenHash(trimmed);
  const userId = await store.consumeToken(hash, 'verify');
  if (userId) {
    await store.updateUser(userId, { emailVerified: true });
    await store.recordConsumedVerify(hash, userId);
    return;
  }

  // Idempotent retry when the token was already consumed (React Strict Mode, double-click).
  const cachedUserId = await store.findConsumedVerify(hash);
  if (cachedUserId) {
    const user = await store.findById(cachedUserId);
    if (user?.emailVerified) return;
  }

  throw new HttpError(400, 'invalid or expired verification token');
}

export async function resendVerification(email: string): Promise<void> {
  const user = await store.findByEmail(email);
  if (!user || user.emailVerified) return; // no enumeration
  await sendVerification(user.email, await issueToken(user.userId, 'verify', VERIFY_TTL_MS));
}

export async function login(
  email: string,
  password: string
): Promise<{ token: string; user: object }> {
  throttle(`login:${email.trim().toLowerCase()}`, 5, 15 * 60 * 1000);
  const user = await store.findByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    throw new HttpError(401, 'invalid email or password');
  }
  if (!user.emailVerified) {
    throw new HttpError(403, 'verify your email before signing in');
  }
  return {
    token: issueJwt(user.userId),
    user: { id: user.userId, email: user.email, name: user.name },
  };
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await store.findByEmail(email);
  if (!user) return; // no enumeration
  await sendPasswordReset(user.email, await issueToken(user.userId, 'reset', RESET_TTL_MS));
}

export async function resetPassword(raw: string, newPassword: string): Promise<void> {
  requireStrong(newPassword);
  const userId = await store.consumeToken(tokenHash(raw || ''), 'reset');
  if (!userId) throw new HttpError(400, 'invalid or expired reset token');
  const { hash, salt } = hashPassword(newPassword);
  await store.updateUser(userId, { passwordHash: hash, passwordSalt: salt });
}

/** Registered Religence team members — not customer CRM contacts. */
export async function listTeamAssignees(): Promise<string[]> {
  return store.listTeamMemberNames();
}
