// One-off admin seeder. Usage: npx tsx scripts/create-admin.ts [email] [password]
// Reuses the real register() path, then force-verifies so login works at once.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

process.env.SMTP_HOST = ''; // console mode — no email sent for the seed

const email = process.argv[2] ?? 'admin@religence.local';
const password = process.argv[3] ?? `${randomBytes(6).toString('base64url')}A1`;

void (async () => {
  const { connectMongo } = await import('../src/db/mongo.js');
  const { register } = await import('../src/services/auth.service.js');
  const { findByEmail, updateUser } = await import('../src/services/auth-store.js');

  await connectMongo();

  if (await findByEmail(email)) {
    console.log(`Admin already exists: ${email}`);
    await mongoose.disconnect();
    return;
  }

  await register('Admin', email, password, password);
  const user = (await findByEmail(email))!;
  await updateUser(user.userId, { emailVerified: true });

  console.log('Admin account created:');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  userId:   ${user.userId}`);
  await mongoose.disconnect();
})();
