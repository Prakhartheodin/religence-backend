import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import config from '../config.js';

/**
 * Encrypt Outlook OAuth tokens at rest. A refresh token is a long-lived,
 * full-mailbox credential — plaintext in Mongo means a leaked backup owns every
 * connected mailbox.
 *
 * Format: `enc:v1:<iv>:<authTag>:<ciphertext>` (all base64). The prefix lets
 * decrypt() pass through legacy plaintext tokens untouched, so this rolls out
 * without a migration: old rows stay readable, new/rewritten rows get encrypted.
 */

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

// 32-byte key derived from TOKEN_ENC_KEY (falls back to AUTH_JWT_SECRET so the
// feature works out of the box; set a dedicated key in prod).
function key(): Buffer {
  const material = config.tokenEncKey || config.jwtSecret;
  if (!material) {
    throw new Error('TOKEN_ENC_KEY (or AUTH_JWT_SECRET) must be set to encrypt Outlook tokens.');
  }
  return createHash('sha256').update(material).digest();
}

export function encryptToken(plain: string | null): string | null {
  if (plain == null || plain === '') return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString(
    'base64'
  )}`;
}

export function decryptToken(stored: string | null): string | null {
  if (stored == null || stored === '') return stored;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !dataB64) return stored;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// demo: round-trips a token and confirms legacy plaintext passes through.
// Run with: node --loader tsx src/services/token-crypto.ts
if (process.argv[1]?.endsWith('token-crypto.ts')) {
  // config is read lazily via key(); stub it for the self-check.
  config.tokenEncKey = 'test-key-not-for-prod';
  const raw = 'refresh-token-abc123';
  const enc = encryptToken(raw);
  if (enc === raw || !enc?.startsWith(PREFIX)) throw new Error('did not encrypt');
  if (decryptToken(enc) !== raw) throw new Error('round-trip failed');
  if (decryptToken('legacy-plaintext') !== 'legacy-plaintext') throw new Error('passthrough failed');
  if (decryptToken(null) !== null || decryptToken('') !== '') throw new Error('nullish failed');
  // eslint-disable-next-line no-console
  console.log('token-crypto self-check passed');
}
