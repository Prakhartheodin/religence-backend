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

type DB = { users: User[]; tokens: OneTimeToken[] };

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
