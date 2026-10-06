import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectApiKeys } from '../db/schema.js';
import { tooManyRequests, unauthorized } from '../errors.js';

// ---------------------------------------------------------------------------
// OpenSSH-Public-Key-Parser (ohne zusätzliche Abhängigkeiten)
// ---------------------------------------------------------------------------

export type SshKeyType = 'ssh-ed25519' | 'ssh-rsa';

export interface ParsedSshPublicKey {
  keyType: SshKeyType;
  /** Rohes OpenSSH-Blob (Grundlage des Fingerprints). */
  blob: Buffer;
  /** Fingerprint im Format von `ssh-keygen -lf`, z. B. "SHA256:AbCd…". */
  fingerprint: string;
  comment: string | null;
  /** Node-KeyObject zur Signaturprüfung. */
  keyObject: KeyObject;
}

export class SshKeyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshKeyParseError';
  }
}

/** SPKI-DER-Präfix für Ed25519 (RFC 8410): SEQUENCE { OID 1.3.101.112, BIT STRING }. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** OID 1.2.840.113549.1.1.1 (rsaEncryption). */
const RSA_OID_DER = Buffer.from('06092a864886f70d010101', 'hex');

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(type: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), derLength(content.length), content]);
}

const derSequence = (content: Buffer) => der(0x30, content);
const derInteger = (bytes: Buffer) => der(0x02, bytes);

/**
 * Baut die SPKI-DER-Struktur für einen RSA-Public-Key. Die mpint-Bytes aus dem
 * OpenSSH-Blob sind bereits DER-kompatibel (minimal, ggf. führende 0x00 für
 * positive Werte).
 */
function rsaSpkiDer(exponent: Buffer, modulus: Buffer): Buffer {
  // RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER } (RFC 8017).
  const rsaPublicKey = derSequence(Buffer.concat([derInteger(modulus), derInteger(exponent)]));
  const algorithm = derSequence(Buffer.concat([RSA_OID_DER, Buffer.from([0x05, 0x00])]));
  const bitString = der(0x03, Buffer.concat([Buffer.from([0x00]), rsaPublicKey]));
  return derSequence(Buffer.concat([algorithm, bitString]));
}

/** Liest ein 4-Byte-längenpräfixiertes Feld aus einem OpenSSH-Blob. */
function readSshString(blob: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > blob.length) {
    throw new SshKeyParseError('SSH-Schlüssel ist unvollständig (Längenfeld fehlt)');
  }
  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > blob.length) {
    throw new SshKeyParseError('SSH-Schlüssel ist unvollständig (Feldlänge passt nicht)');
  }
  return { value: blob.subarray(start, end), next: end };
}

/**
 * Parst einen einzeiligen OpenSSH-Public-Key ("ssh-ed25519 AAAA… [comment]").
 * Wirft bei ungültigem Format einen `SshKeyParseError`.
 */
export function parseOpenSshPublicKey(line: string): ParsedSshPublicKey {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new SshKeyParseError('Format "<Typ> <base64> [Kommentar]" erwartet');
  }
  const [typeToken = '', base64Token = '', ...commentParts] = parts;
  if (typeToken !== 'ssh-ed25519' && typeToken !== 'ssh-rsa') {
    throw new SshKeyParseError(
      `Nicht unterstützter Schlüsseltyp "${typeToken}" (erlaubt: ssh-ed25519, ssh-rsa)`,
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Token)) {
    throw new SshKeyParseError('Base64-Teil des Schlüssels ist ungültig');
  }

  const blob = Buffer.from(base64Token, 'base64');
  if (blob.length === 0) {
    throw new SshKeyParseError('Schlüsseldaten sind leer');
  }

  const typeField = readSshString(blob, 0);
  if (typeField.value.toString('utf8') !== typeToken) {
    throw new SshKeyParseError('Schlüsseltyp und Schlüsseldaten passen nicht zusammen');
  }

  let spkiDer: Buffer;
  if (typeToken === 'ssh-ed25519') {
    const keyField = readSshString(blob, typeField.next);
    if (keyField.value.length !== 32) {
      throw new SshKeyParseError('Ed25519-Schlüssel muss 32 Byte lang sein');
    }
    spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, keyField.value]);
  } else {
    const exponentField = readSshString(blob, typeField.next);
    const modulusField = readSshString(blob, exponentField.next);
    if (exponentField.value.length === 0 || modulusField.value.length === 0) {
      throw new SshKeyParseError('RSA-Schlüssel enthält keinen Exponenten/Modulus');
    }
    spkiDer = rsaSpkiDer(exponentField.value, modulusField.value);
  }

  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    throw new SshKeyParseError('Schlüsseldaten konnten nicht als Public Key gelesen werden');
  }

  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  const comment = commentParts.length > 0 ? commentParts.join(' ') : null;
  return { keyType: typeToken, blob, fingerprint, comment, keyObject };
}

// ---------------------------------------------------------------------------
// Signaturprüfung
// ---------------------------------------------------------------------------

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Kanonischer String der Anfrage:
 * `keyId + "\n" + timestamp + "\n" + METHOD + "\n" + originalUrl + "\n" + sha256hex(rawBody)`
 *
 * `timestamp`/`keyId` gehen exakt so ein, wie sie im Header stehen (nach Trim).
 */
export function buildCanonicalString(parts: {
  keyId: string | number;
  timestamp: string | number;
  method: string;
  url: string;
  bodyHashHex: string;
}): string {
  return [
    String(parts.keyId),
    String(parts.timestamp),
    parts.method.toUpperCase(),
    parts.url,
    parts.bodyHashHex,
  ].join('\n');
}

/** Prüft eine base64-Signatur gegen den kanonischen String. */
export function verifySshSignature(
  parsedKey: ParsedSshPublicKey,
  data: Buffer,
  signature: Buffer,
): boolean {
  try {
    // Ed25519 verifies the message directly; RSA-SHA256 nutzt PKCS#1 v1.5.
    const algorithm = parsedKey.keyType === 'ssh-ed25519' ? null : 'sha256';
    return cryptoVerify(algorithm, data, parsedKey.keyObject, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Express-Middleware
// ---------------------------------------------------------------------------

export const SSH_HEADERS = {
  KEY_ID: 'x-pp-key-id',
  TIMESTAMP: 'x-pp-timestamp',
  SIGNATURE: 'x-pp-signature',
} as const;

/** Zulässige Abweichung der Client-Uhr (± Sekunden). */
export const SSH_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface ApiKeyContext {
  id: number;
  projectId: number;
  name: string;
}

/** Replay-Schutz: Timestamp muss innerhalb von ±300 s zur Serverzeit liegen. */
export function isTimestampWithinTolerance(timestampSeconds: number, nowMs = Date.now()): boolean {
  return Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) <= SSH_TIMESTAMP_TOLERANCE_SECONDS;
}

/** Prüft Aktiv-Status und Ablauf eines Schlüssels; `null` = verwendbar. */
export function apiKeyInvalidReason(
  key: { isActive: boolean; expiresAt: Date | null },
  nowMs = Date.now(),
): 'inactive' | 'expired' | null {
  if (!key.isActive) return 'inactive';
  if (key.expiresAt !== null && key.expiresAt.getTime() <= nowMs) return 'expired';
  return null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Roher Request-Body (vom express.json `verify`-Callback gesetzt). */
      rawBody?: Buffer;
      /** Nach erfolgreicher SSH-Authentifizierung gesetzter Schlüsselkontext. */
      apiKey?: ApiKeyContext;
    }
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value[0] : value)?.trim();
}

export interface SshAuthInput {
  /** Werte exakt aus den Headern (nach Trim); fehlend = `undefined`. */
  keyId?: string | undefined;
  timestamp?: string | undefined;
  signature?: string | undefined;
  method: string;
  /** Pfad inkl. Query, wie ihn der Server für die Signatur sieht. */
  url: string;
  rawBody: Buffer;
}

/**
 * Prüft die SSH-Signatur eines Requests und liefert den Schlüsselkontext.
 * Wird sowohl von der externen API (`sshAuth`-Middleware) als auch vom
 * internen Verify-Endpunkt (`POST /internal/verify-ssh`) genutzt, damit die
 * Prüflogik exakt einmal existiert.
 */
/** Cache bereits verwendeter Signaturen (Key+Timestamp+Signatur) für den Replay-Schutz. */
const REPLAY_CACHE_MAX = 10_000;
const usedSignatures = new Map<string, number>();

function isReplay(keyId: number, timestamp: string, signature: string): boolean {
  const now = Date.now();
  if (usedSignatures.size > 0) {
    for (const [hash, expiresAt] of usedSignatures) {
      if (expiresAt <= now) usedSignatures.delete(hash);
      else break; // Insertion-Order: spätere Einträge laufen ebenfalls später ab
    }
  }
  while (usedSignatures.size >= REPLAY_CACHE_MAX) {
    const oldest = usedSignatures.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    usedSignatures.delete(oldest);
  }

  const replayHash = sha256Hex(Buffer.from(`${keyId}:${timestamp}:${signature}`, 'utf8'));
  if (usedSignatures.has(replayHash)) return true;
  usedSignatures.set(
    replayHash,
    (Number(timestamp) + SSH_TIMESTAMP_TOLERANCE_SECONDS) * 1000,
  );
  return false;
}

export async function authenticateSshRequest(input: SshAuthInput): Promise<ApiKeyContext> {
  const keyIdRaw = input.keyId;
  const timestampRaw = input.timestamp;
  const signatureRaw = input.signature;

  if (!keyIdRaw || !timestampRaw || !signatureRaw) {
    throw unauthorized('SSH-Header fehlen (x-pp-key-id, x-pp-timestamp, x-pp-signature)');
  }
  if (!/^\d+$/.test(keyIdRaw) || Number(keyIdRaw) <= 0) {
    throw unauthorized('Ungültige Key-ID');
  }
  if (!/^\d+$/.test(timestampRaw)) {
    throw unauthorized('Ungültiger Timestamp (Unix-Sekunden erwartet)');
  }
  if (!isTimestampWithinTolerance(Number(timestampRaw))) {
    throw unauthorized(
      `Timestamp außerhalb des erlaubten Fensters (±${SSH_TIMESTAMP_TOLERANCE_SECONDS} s)`,
    );
  }

  const [key] = await db
    .select()
    .from(projectApiKeys)
    .where(eq(projectApiKeys.id, Number(keyIdRaw)))
    .limit(1);
  if (!key) throw unauthorized('API-Schlüssel nicht gefunden');
  const invalidReason = apiKeyInvalidReason(key);
  if (invalidReason === 'inactive') throw unauthorized('API-Schlüssel ist deaktiviert');
  if (invalidReason === 'expired') throw unauthorized('API-Schlüssel ist abgelaufen');

  let parsedKey: ParsedSshPublicKey;
  try {
    parsedKey = parseOpenSshPublicKey(key.publicKey);
  } catch {
    throw unauthorized('Hinterlegter API-Schlüssel ist ungültig');
  }

  const signature = Buffer.from(signatureRaw, 'base64');
  if (signature.length === 0) {
    throw unauthorized('Signatur ist kein gültiges Base64');
  }

  const canonical = buildCanonicalString({
    keyId: keyIdRaw,
    timestamp: timestampRaw,
    method: input.method,
    url: input.url,
    bodyHashHex: sha256Hex(input.rawBody),
  });
  if (!verifySshSignature(parsedKey, Buffer.from(canonical, 'utf8'), signature)) {
    throw unauthorized('Signatur ungültig');
  }

  // Replay-Schutz: exakt dieselbe Signatur (Key+Timestamp+Signatur) darf nur
  // einmal verwendet werden – innerhalb des Toleranzfensters gecacht.
  if (isReplay(key.id, timestampRaw, signatureRaw)) {
    throw unauthorized('Signatur wurde bereits verwendet (Replay)');
  }

  const context: ApiKeyContext = { id: key.id, projectId: key.projectId, name: key.name };
  await db
    .update(projectApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(projectApiKeys.id, key.id));
  return context;
}

/**
 * Authentifiziert Requests externer Clients per SSH-Public-Key.
 * Erwartet `x-pp-key-id`, `x-pp-timestamp` (Unix-Sekunden) und
 * `x-pp-signature` (base64 über den kanonischen String, siehe docs/API-external.md).
 */
export async function sshAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.apiKey = await authenticateSshRequest({
      keyId: singleHeader(req.headers[SSH_HEADERS.KEY_ID]),
      timestamp: singleHeader(req.headers[SSH_HEADERS.TIMESTAMP]),
      signature: singleHeader(req.headers[SSH_HEADERS.SIGNATURE]),
      method: req.method,
      url: req.originalUrl,
      rawBody: req.rawBody ?? Buffer.alloc(0),
    });
    next();
  } catch (err) {
    next(err);
  }
}

/** Rate-Limit pro API-Schlüssel: standardmäßig 120 Anfragen pro Minute. */
export const apiKeyRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `api-key:${req.apiKey?.id ?? 'unknown'}`,
  handler: (_req, _res, next) =>
    next(tooManyRequests('Zu viele Anfragen für diesen API-Schlüssel (max. 120/min)')),
});
