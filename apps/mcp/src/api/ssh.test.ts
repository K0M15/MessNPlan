import {
  createHash,
  generateKeyPairSync,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCanonicalString,
  inferKeyType,
  signSshRequest,
  SshSignedApi,
} from './ssh.js';
import { UnsupportedOperationError } from './types.js';

/** sha256hex wie im Signaturschema (docs/API-external.md). */
function hashForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const ed25519 = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

const keyDir = mkdtempSync(join(tmpdir(), 'pp-mcp-keys-'));
const ed25519KeyPath = join(keyDir, 'ed25519.pem');
const rsaKeyPath = join(keyDir, 'rsa.pem');
writeFileSync(ed25519KeyPath, ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(rsaKeyPath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function mockFetch(responseBody: unknown, status = 201) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { requests: CapturedRequest[] };
  fetchImpl.requests = requests;
  return fetchImpl;
}

// ---------------------------------------------------------------------------
// Signatur
// ---------------------------------------------------------------------------

describe('signSshRequest', () => {
  const baseOptions = {
    keyId: 42,
    method: 'post',
    url: '/api/v1/external/projects/7/tasks',
    body: '{"name":"MCP"}',
    timestamp: 1_700_000_000,
  };

  it('erzeugt Header, deren Ed25519-Signatur zum kanonischen String passt', () => {
    const headers = signSshRequest({
      ...baseOptions,
      privateKey: ed25519.privateKey,
      keyType: 'ssh-ed25519',
    });

    expect(headers['x-pp-key-id']).toBe('42');
    expect(headers['x-pp-timestamp']).toBe('1700000000');

    const canonical = buildCanonicalString({
      keyId: '42',
      timestamp: '1700000000',
      method: 'post',
      url: baseOptions.url,
      bodyHashHex: '0a1b2c',
    });
    expect(canonical.split('\n')).toEqual([
      '42',
      '1700000000',
      'POST',
      '/api/v1/external/projects/7/tasks',
      '0a1b2c',
    ]);

    // Signatur gegen den erwarteten kanonischen String prüfen.
    const expected = buildCanonicalString({
      keyId: '42',
      timestamp: '1700000000',
      method: 'POST',
      url: baseOptions.url,
      bodyHashHex: hashForTest(baseOptions.body),
    });
    const valid = cryptoVerify(
      null,
      Buffer.from(expected, 'utf8'),
      ed25519.publicKey,
      Buffer.from(headers['x-pp-signature']!, 'base64'),
    );
    expect(valid).toBe(true);
  });

  it('signiert RSA mit SHA-256 (PKCS#1 v1.5)', () => {
    const headers = signSshRequest({
      ...baseOptions,
      privateKey: rsa.privateKey,
      keyType: 'ssh-rsa',
    });
    const expected = buildCanonicalString({
      keyId: '42',
      timestamp: '1700000000',
      method: 'POST',
      url: baseOptions.url,
      bodyHashHex: hashForTest(baseOptions.body),
    });
    const valid = cryptoVerify(
      'sha256',
      Buffer.from(expected, 'utf8'),
      rsa.publicKey,
      Buffer.from(headers['x-pp-signature']!, 'base64'),
    );
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe('SshSignedApi', () => {
  it('leitet den Schlüsseltyp aus dem Schlüssel ab', () => {
    expect(inferKeyType(ed25519.privateKey as KeyObject)).toBe('ssh-ed25519');
    expect(inferKeyType(rsa.privateKey as KeyObject)).toBe('ssh-rsa');
  });

  it('sendet signierte Create-Requests an die externe API', async () => {
    const fetchImpl = mockFetch({ task: { id: 11, name: 'MCP-Aufgabe' } });
    const api = new SshSignedApi({
      baseUrl: 'http://api.test',
      keyId: 42,
      privateKeyPath: ed25519KeyPath,
      fetchImpl,
      now: () => 1_700_000_000_000,
    });

    const result = await api.createTask(7, { name: 'MCP-Aufgabe', estimatedMinutes: 30 });

    expect(result.task.id).toBe(11);
    const [request] = fetchImpl.requests;
    expect(request!.method).toBe('POST');
    expect(new URL(request!.url).pathname).toBe('/api/v1/external/projects/7/tasks');
    expect(request!.body).toBe(JSON.stringify({ name: 'MCP-Aufgabe', estimatedMinutes: 30 }));

    // Mock-Verifier: kanonischen String nachbauen und Signatur prüfen.
    const canonical = buildCanonicalString({
      keyId: request!.headers.get('x-pp-key-id')!,
      timestamp: request!.headers.get('x-pp-timestamp')!,
      method: request!.method,
      url: new URL(request!.url).pathname,
      bodyHashHex: hashForTest(request!.body ?? ''),
    });
    expect(
      cryptoVerify(
        null,
        Buffer.from(canonical, 'utf8'),
        ed25519.publicKey,
        Buffer.from(request!.headers.get('x-pp-signature')!, 'base64'),
      ),
    ).toBe(true);
  });

  it('prüft die optionale Projektbindung vor dem Request', async () => {
    const fetchImpl = mockFetch({});
    const api = new SshSignedApi({
      baseUrl: 'http://api.test',
      keyId: 42,
      privateKeyPath: ed25519KeyPath,
      projectId: 3,
      fetchImpl,
    });

    await expect(api.createTask(4, { name: 'Fremd' })).rejects.toThrow(/an Projekt 3 gebunden/);
    expect(fetchImpl.requests).toHaveLength(0);
  });

  it('lehnt einen falschen PP_KEY_TYPE ab', () => {
    expect(
      () =>
        new SshSignedApi({
          baseUrl: 'http://api.test',
          keyId: 1,
          privateKeyPath: ed25519KeyPath,
          keyType: 'ssh-rsa',
        }),
    ).toThrow(/passt nicht/);
  });

  it('unterstützt lesende Tools nicht', async () => {
    const api = new SshSignedApi({
      baseUrl: 'http://api.test',
      keyId: 1,
      privateKeyPath: ed25519KeyPath,
    });
    expect(() => api.listProjects()).toThrow(UnsupportedOperationError);
    expect(() => api.getGantt(1)).toThrow(/nicht verfügbar/);
  });
});
