import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (Default-Algorithmus der Bibliothek) mit OWASP-Empfehlungen.
 * Die Parameter sind im Hash-String kodiert, `verify` erkennt sie automatisch.
 */
const OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
