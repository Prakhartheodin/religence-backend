import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ponytail: single-file JSON store — durable across restarts, zero deps,
// single-process only. Swap for SQLite/Mongo if this ever runs multi-instance.

export type User = {
  userId: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  emailVerified: boolean;
  createdAt: string;
};

export type OneTimeToken = {
  tokenHash: string;
  userId: string;
  purpose: 'verify' | 'reset';
  expiresAt: number;
};

type ConsumedVerify = { userId: string; consumedAt: number };

type DB = {
  users: User[];
  tokens: OneTimeToken[];
  /** Recently consumed verify tokens — idempotent retries (e.g. React Strict Mode). */
  consumedVerify?: Record<string, ConsumedVerify>;
};

const FILE = resolve(process.env.AUTH_STORE_PATH ?? 'data/auth.json');
let db: DB = load();

function load(): DB {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as DB;
  } catch {
    return { users: [], tokens: [] };
  }
}

function save(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

const norm = (email: string): string => email.trim().toLowerCase();

export function findByEmail(email: string): User | undefined {
  const e = norm(email);
  return db.users.find((u) => u.email === e);
}

export function findById(userId: string): User | undefined {
  return db.users.find((u) => u.userId === userId);
}

export function createUser(u: User): User {
  db.users.push(u);
  save();
  return u;
}

export function updateUser(userId: string, patch: Partial<User>): void {
  const u = findById(userId);
  if (!u) return;
  Object.assign(u, patch);
  save();
}

export function addToken(t: OneTimeToken): void {
  db.tokens.push(t);
  save();
}

/** Single-use: removes any matching hash, returns userId if valid+unexpired. */
export function consumeToken(tokenHash: string, purpose: OneTimeToken['purpose']): string | null {
  const idx = db.tokens.findIndex((t) => t.tokenHash === tokenHash && t.purpose === purpose);
  if (idx === -1) return null;
  const [tok] = db.tokens.splice(idx, 1);
  save();
  return tok.expiresAt < Date.now() ? null : tok.userId;
}

const CONSUMED_VERIFY_TTL_MS = 24 * 3600 * 1000;

function pruneConsumedVerify(): void {
  if (!db.consumedVerify) return;
  const cutoff = Date.now() - CONSUMED_VERIFY_TTL_MS;
  for (const [hash, entry] of Object.entries(db.consumedVerify)) {
    if (entry.consumedAt < cutoff) delete db.consumedVerify[hash];
  }
}

/** Remember a consumed verify token so duplicate requests still succeed. */
export function recordConsumedVerify(tokenHash: string, userId: string): void {
  if (!db.consumedVerify) db.consumedVerify = {};
  pruneConsumedVerify();
  db.consumedVerify[tokenHash] = { userId, consumedAt: Date.now() };
  save();
}

/** Returns userId if this verify token was recently consumed successfully. */
export function findConsumedVerify(tokenHash: string): string | null {
  const entry = db.consumedVerify?.[tokenHash];
  if (!entry) return null;
  if (Date.now() - entry.consumedAt > CONSUMED_VERIFY_TTL_MS) return null;
  return entry.userId;
}
