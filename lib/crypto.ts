/**
 * Symmetric encryption for CRM credentials at rest — added per Jairo's
 * 26 Aug 2026 feedback ("CRM access keys aren't encrypted at rest"). Used
 * by lib/config.ts's session-override file today, and is the same helper
 * lib/airtable.ts's writeClientConfigToAirtable should call once the §5.2
 * fields actually exist.
 *
 * AES-256-GCM with a key from CONFIG_ENCRYPTION_KEY (32 bytes, base64 —
 * generate with `openssl rand -base64 32`). If that env var isn't set,
 * this degrades to storing plaintext rather than hard-crashing the app —
 * consistent with every other graceful-degradation gap in this codebase —
 * but logs a warning once so it's never a silent security gap. Set the key
 * before any real client's credentials touch this.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { logger } from './log';

const ALGO = 'aes-256-gcm';
let warnedOnce = false;

function encryptionKey(): Buffer | null {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn(
        'CONFIG_ENCRYPTION_KEY is not set — credentials will be stored in plaintext. ' +
          'Set it (openssl rand -base64 32) before any real client uses this outside local testing.',
      );
    }
    return null;
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Prefix marks a value as encrypted so decrypt() can tell it apart from legacy plaintext. */
const PREFIX = 'enc:v1:';

export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext, or encryption disabled
  const key = encryptionKey();
  if (!key) {
    throw new Error(
      'Stored value is encrypted but CONFIG_ENCRYPTION_KEY is not set — cannot decrypt. ' +
        'Set the same key that was used to encrypt it.',
    );
  }
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Encrypts every value in a flat string record (e.g. cfg.crm.credentials). */
export function encryptRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, encryptSecret(v)]));
}

export function decryptRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decryptSecret(v)]));
}
