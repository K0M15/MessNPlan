import { describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, encryptionAvailable } from './crypto.js';

// Deterministischer Key, bevor config/crypto importiert werden
// (dotenv überschreibt bereits gesetzte Variablen nicht; CI hat hier sonst einen leeren Key).
vi.hoisted(() => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

/** Kippt das erste Byte der base64url-kodierten Daten (GCM-Authentifizierung schlägt dann fehl). */
function tamper(base64url: string): string {
  const bytes = Buffer.from(base64url, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64url');
}

function split(payload: string): { iv: string; tag: string; data: string } {
  const parts = payload.split(':');
  const iv = parts[0];
  const tag = parts[1];
  const data = parts[2];
  if (!iv || !tag || !data) throw new Error(`Testdaten ungültig: ${payload}`);
  return { iv, tag, data };
}

describe('crypto', () => {
  it('encryptSecret/decryptSecret Roundtrip inkl. Sonderzeichen', () => {
    const plaintext = 'refresh: ÄÖÜß/+= & <tag> "Quotes" \'einfach\' 🚀\nzweite Zeile';
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('verwendet bei jedem Aufruf einen neuen IV', () => {
    expect(encryptSecret('gleicher Klartext')).not.toBe(encryptSecret('gleicher Klartext'));
  });

  it('scheitert an manipuliertem Ciphertext', () => {
    const { iv, tag, data } = split(encryptSecret('streng geheim'));
    expect(() => decryptSecret(`${iv}:${tag}:${tamper(data)}`)).toThrow();
  });

  it('scheitert an manipuliertem Auth-Tag', () => {
    const { iv, tag, data } = split(encryptSecret('streng geheim'));
    expect(() => decryptSecret(`${iv}:${tamper(tag)}:${data}`)).toThrow();
  });

  it('lehnt ungültiges Format ab', () => {
    expect(() => decryptSecret('kein-format')).toThrow('Ungültiges verschlüsseltes Format');
    expect(() => decryptSecret('nur:zwei')).toThrow('Ungültiges verschlüsseltes Format');
  });

  it('meldet Verschlüsselung als verfügbar (APP_ENCRYPTION_KEY gesetzt)', () => {
    expect(encryptionAvailable()).toBe(true);
  });
});
