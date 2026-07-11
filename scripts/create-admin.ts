// One-off admin seeder. Usage: npx tsx scripts/create-admin.ts [email] [password]
// Reuses the real register() path, then force-verifies so login works at once.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

process.env.SMTP_URL = ''; // console mode — no email sent for the seed

const email = process.argv[2] ?? 'admin@religence.local';
const password = process.argv[3] ?? `${randomBytes(6).toString('base64url')}A1`;
const number = process.argv[4] ?? '+910000000000';

void (async () => {
  const { register } = await import('../src/services/auth.service.js');
  const { findByEmail, updateUser } = await import('../src/services/auth-store.js');

  if (findByEmail(email)) {
    console.log(`Admin already exists: ${email}`);
    return;
  }

  await register('Admin', email, number, password, password);
  const user = findByEmail(email)!;
  updateUser(user.userId, { emailVerified: true });

  console.log('Admin account created:');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  userId:   ${user.userId}`);
})();
