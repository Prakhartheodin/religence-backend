// One-off migration: data/auth.json -> Mongo (users + auth_tokens).
// Usage: npx tsx scripts/seed-users.ts [path/to/auth.json]
// Idempotent — re-running upserts by userId / tokenHash. Leaves the JSON file alone.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { connectMongo } from '../src/db/mongo.js';
import { AuthTokenModel } from '../src/models/auth-token.model.js';
import { UserModel, type UserDoc } from '../src/models/user.model.js';

type LegacyToken = {
  tokenHash: string;
  userId: string;
  purpose: 'verify' | 'reset';
  expiresAt: number;
};
type LegacyUser = Omit<UserDoc, 'createdAt'> & { createdAt: string };
type LegacyDB = {
  users?: LegacyUser[];
  tokens?: LegacyToken[];
  consumedVerify?: Record<string, { userId: string; consumedAt: number }>;
};

const FILE = resolve(process.argv[2] ?? process.env.AUTH_STORE_PATH ?? 'data/auth.json');
const CONSUMED_VERIFY_TTL_MS = 24 * 3600 * 1000;

void (async () => {
  const db = JSON.parse(readFileSync(FILE, 'utf8')) as LegacyDB;
  await connectMongo();

  for (const u of db.users ?? []) {
    await UserModel.updateOne(
      { userId: u.userId },
      {
        $set: {
          email: u.email.trim().toLowerCase(),
          name: u.name,
          passwordHash: u.passwordHash,
          passwordSalt: u.passwordSalt,
          emailVerified: u.emailVerified,
          createdAt: new Date(u.createdAt),
        },
      },
      { upsert: true }
    );
  }

  for (const t of db.tokens ?? []) {
    await AuthTokenModel.updateOne(
      { tokenHash: t.tokenHash, purpose: t.purpose },
      { $set: { userId: t.userId, expiresAt: new Date(t.expiresAt) } },
      { upsert: true }
    );
  }

  for (const [tokenHash, entry] of Object.entries(db.consumedVerify ?? {})) {
    await AuthTokenModel.updateOne(
      { tokenHash, purpose: 'verify-consumed' },
      {
        $set: {
          userId: entry.userId,
          expiresAt: new Date(entry.consumedAt + CONSUMED_VERIFY_TTL_MS),
        },
      },
      { upsert: true }
    );
  }

  console.log(`Seeded from ${FILE}`);
  console.log(`  users:            ${await UserModel.countDocuments()}`);
  console.log(`  auth_tokens:      ${await AuthTokenModel.countDocuments()}`);
  for (const u of await UserModel.find().lean<UserDoc[]>()) {
    console.log(`  - ${u.email} (${u.userId}) verified=${u.emailVerified}`);
  }
  await mongoose.disconnect();
})();
