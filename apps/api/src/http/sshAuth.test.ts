import { execFileSync, execSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiKeyInvalidReason,
  buildCanonicalString,
  isTimestampWithinTolerance,
  parseOpenSshPublicKey,
  sha256Hex,
  SshKeyParseError,
  SSH_TIMESTAMP_TOLERANCE_SECONDS,
  verifySshSignature,
} from './sshAuth.js';

// ---------------------------------------------------------------------------
// Hilfen: Node-Keys ins OpenSSH-Format bringen
// ---------------------------------------------------------------------------

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

/** OpenSSH-mpint: minimal, ggf. führendes 0x00 damit der Wert positiv bleibt. */
function sshMpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  let bytes = value.subarray(start);
  if (bytes.length > 0 && (bytes[0]! & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return sshString(bytes);
}

function toOpenSsh(publicKey: KeyObject, type: 'ssh-ed25519' | 'ssh-rsa') {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const blob =
    type === 'ssh-ed25519'
      ? Buffer.concat([sshString(Buffer.from(type)), sshString(Buffer.from(jwk.x!, 'base64url'))])
      : Buffer.concat([
          sshString(Buffer.from(type)),
          sshMpint(Buffer.from(jwk.e!, 'base64url')),
          sshMpint(Buffer.from(jwk.n!, 'base64url')),
        ]);
  return { line: `${type} ${blob.toString('base64')} test@example`, blob };
}

const ed25519 = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed25519Key = toOpenSsh(ed25519.publicKey, 'ssh-ed25519');
const rsaKey = toOpenSsh(rsa.publicKey, 'ssh-rsa');

function signCanonical(privateKey: KeyObject, type: 'ssh-ed25519' | 'ssh-rsa', data: Buffer) {
  return type === 'ssh-ed25519' ? cryptoSign(null, data, privateKey) : cryptoSign('sha256', data, privateKey);
}

const sampleCanonical = buildCanonicalString({
  keyId: 42,
  timestamp: 1_700_000_000,
  method: 'POST',
  url: '/api/v1/external/projects/7/tasks',
  bodyHashHex: sha256Hex(Buffer.from('{"name":"Test"}')),
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parseOpenSshPublicKey', () => {
  it('parst ssh-ed25519 inkl. Fingerprint und Kommentar', () => {
    const parsed = parseOpenSshPublicKey(ed25519Key.line);
    expect(parsed.keyType).toBe('ssh-ed25519');
    expect(parsed.comment).toBe('test@example');
    const expected = `SHA256:${createHash('sha256').update(ed25519Key.blob).digest('base64').replace(/=+$/, '')}`;
    expect(parsed.fingerprint).toBe(expected);
    expect(parsed.keyObject.asymmetricKeyType).toBe('ed25519');
  });

  it('parst ssh-rsa inkl. Exponent/Modulus', () => {
    const parsed = parseOpenSshPublicKey(rsaKey.line);
    expect(parsed.keyType).toBe('ssh-rsa');
    expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(parsed.keyObject.asymmetricKeyType).toBe('rsa');
  });

  it('akzeptiert Keys ohne Kommentar und mit Whitespace', () => {
    const withoutComment = ed25519Key.line.split(' ').slice(0, 2).join(' ');
    const parsed = parseOpenSshPublicKey(`  ${withoutComment}  \n`);
    expect(parsed.comment).toBeNull();
    expect(parsed.fingerprint).toContain('SHA256:');
  });

  it('lehnt nicht unterstützte Typen ab', () => {
    expect(() => parseOpenSshPublicKey('ecdsa-sha2-nistp256 AAAA test')).toThrow(SshKeyParseError);
  });

  it('lehnt unvollständige oder widersprüchliche Daten ab', () => {
    expect(() => parseOpenSshPublicKey('ssh-ed25519')).toThrow(/Format/);
    expect(() => parseOpenSshPublicKey('ssh-ed25519 not_base64!!')).toThrow(/Base64/);
    expect(() => parseOpenSshPublicKey('ssh-ed25519 ' + Buffer.from('kurz').toString('base64'))).toThrow(
      SshKeyParseError,
    );
    // Typ-Token passt nicht zum Blob-Inhalt.
    const wrongTypeBlob = Buffer.from(rsaKey.line.split(' ')[1]!, 'base64');
    expect(() => parseOpenSshPublicKey(`ssh-ed25519 ${wrongTypeBlob.toString('base64')}`)).toThrow(
      /passen nicht zusammen/,
    );
  });
});

// ---------------------------------------------------------------------------
// Signaturprüfung
// ---------------------------------------------------------------------------

describe('verifySshSignature', () => {
  it('akzeptiert Ed25519-Signaturen, lehnt manipulierte Daten ab', () => {
    const parsed = parseOpenSshPublicKey(ed25519Key.line);
    const data = Buffer.from(sampleCanonical, 'utf8');
    const signature = signCanonical(ed25519.privateKey, 'ssh-ed25519', data);
    expect(verifySshSignature(parsed, data, signature)).toBe(true);
    expect(verifySshSignature(parsed, Buffer.from(`${sampleCanonical}!`), signature)).toBe(false);
    expect(verifySshSignature(parsed, data, Buffer.from('kaputt'))).toBe(false);
  });

  it('akzeptiert RSA-SHA256-Signaturen, lehnt manipulierte Daten ab', () => {
    const parsed = parseOpenSshPublicKey(rsaKey.line);
    const data = Buffer.from(sampleCanonical, 'utf8');
    const signature = signCanonical(rsa.privateKey, 'ssh-rsa', data);
    expect(verifySshSignature(parsed, data, signature)).toBe(true);
    expect(verifySshSignature(parsed, Buffer.from(`${sampleCanonical}x`), signature)).toBe(false);
  });

  it('lehnt eine Signatur eines anderen Schlüssels ab', () => {
    const other = generateKeyPairSync('ed25519');
    const parsed = parseOpenSshPublicKey(ed25519Key.line);
    const data = Buffer.from(sampleCanonical, 'utf8');
    const signature = signCanonical(other.privateKey, 'ssh-ed25519', data);
    expect(verifySshSignature(parsed, data, signature)).toBe(false);
  });
});

describe('buildCanonicalString', () => {
  it('verbindet die Bestandteile mit \\n in der dokumentierten Reihenfolge', () => {
    expect(sampleCanonical.split('\n')).toEqual([
      '42',
      '1700000000',
      'POST',
      '/api/v1/external/projects/7/tasks',
      sha256Hex(Buffer.from('{"name":"Test"}')),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ablauf & Replay-Fenster
// ---------------------------------------------------------------------------

describe('isTimestampWithinTolerance (Replay-Schutz)', () => {
  const now = 1_700_000_000_000;

  it('akzeptiert Timestamps im ±300-s-Fenster', () => {
    expect(isTimestampWithinTolerance(now / 1000, now)).toBe(true);
    expect(isTimestampWithinTolerance(now / 1000 - SSH_TIMESTAMP_TOLERANCE_SECONDS, now)).toBe(true);
    expect(isTimestampWithinTolerance(now / 1000 + SSH_TIMESTAMP_TOLERANCE_SECONDS, now)).toBe(true);
  });

  it('lehnt alte und zukünftige Timestamps ab', () => {
    expect(isTimestampWithinTolerance(now / 1000 - 3600, now)).toBe(false);
    expect(isTimestampWithinTolerance(now / 1000 + 3600, now)).toBe(false);
    expect(isTimestampWithinTolerance(now / 1000 - SSH_TIMESTAMP_TOLERANCE_SECONDS - 1, now)).toBe(false);
  });
});

describe('apiKeyInvalidReason (Aktiv & Ablauf)', () => {
  const now = 1_700_000_000_000;

  it('meldet aktive, unbefristete und zukünftig ablaufende Schlüssel als gültig', () => {
    expect(apiKeyInvalidReason({ isActive: true, expiresAt: null }, now)).toBeNull();
    expect(apiKeyInvalidReason({ isActive: true, expiresAt: new Date(now + 60_000) }, now)).toBeNull();
  });

  it('meldet deaktivierte Schlüssel', () => {
    expect(apiKeyInvalidReason({ isActive: false, expiresAt: null }, now)).toBe('inactive');
  });

  it('meldet abgelaufene Schlüssel (auch exakt zum Ablaufzeitpunkt)', () => {
    expect(apiKeyInvalidReason({ isActive: true, expiresAt: new Date(now - 1) }, now)).toBe('expired');
    expect(apiKeyInvalidReason({ isActive: true, expiresAt: new Date(now) }, now)).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// Abgleich mit ssh-keygen (nur wenn verfügbar)
// ---------------------------------------------------------------------------

function sshKeygenAvailable(): boolean {
  try {
    execSync('command -v ssh-keygen', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(sshKeygenAvailable())('Abgleich mit ssh-keygen', () => {
  it('Fingerprint entspricht `ssh-keygen -lf` (Ed25519)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-ssh-'));
    try {
      const keyPath = join(dir, 'id_ed25519');
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyPath], { stdio: 'ignore' });
      const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim();
      const parsed = parseOpenSshPublicKey(pub);
      const out = execFileSync('ssh-keygen', ['-lf', `${keyPath}.pub`], { encoding: 'utf8' });
      expect(out.match(/SHA256:[A-Za-z0-9+/]+/)?.[0]).toBe(parsed.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Fingerprint entspricht `ssh-keygen -lf` (RSA)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-ssh-'));
    try {
      const keyPath = join(dir, 'id_rsa');
      execFileSync('ssh-keygen', ['-t', 'rsa', '-b', '2048', '-N', '', '-q', '-f', keyPath], {
        stdio: 'ignore',
      });
      const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim();
      const parsed = parseOpenSshPublicKey(pub);
      const out = execFileSync('ssh-keygen', ['-lf', keyPath], { encoding: 'utf8' });
      expect(out.match(/SHA256:[A-Za-z0-9+/]+/)?.[0]).toBe(parsed.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
