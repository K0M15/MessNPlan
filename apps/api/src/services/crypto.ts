import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';

export function encryptionAvailable(): boolean {
  if (!config.APP_ENCRYPTION_KEY) return false;
  try {
    return key().length === 32;
  } catch {
    return false;
  }
}

function key(): Buffer {
  if (!config.APP_ENCRYPTION_KEY) {
    throw new Error('APP_ENCRYPTION_KEY ist nicht gesetzt');
  }
  const buffer = Buffer.from(config.APP_ENCRYPTION_KEY, 'base64');
  if (buffer.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY muss 32 Byte base64 sein (openssl rand -base64 32)');
  }
  return buffer;
}

/** AES-256-GCM: iv:tag:ciphertext (base64url) */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(
    ':',
  );
}

export function decryptSecret(payload: string): string {
  const [ivRaw, tagRaw, dataRaw] = payload.split(':');
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Ungültiges verschlüsseltes Format');
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
