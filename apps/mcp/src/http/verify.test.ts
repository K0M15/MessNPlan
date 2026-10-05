import { describe, expect, it } from 'vitest';
import { InternalSshVerifier, type SshVerifyInput } from './verify.js';

interface CapturedRequest {
  url: string;
  method: string;
  token: string | null;
  body: { keyId?: string; rawBody?: string } | null;
}

function makeFetch(status: number, body: unknown) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? 'GET',
      token: headers.get('x-internal-token'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { requests: CapturedRequest[] };
  fetchImpl.requests = requests;
  return fetchImpl;
}

const input: SshVerifyInput = {
  keyId: '7',
  timestamp: '1700000000',
  signature: 'c2ln',
  method: 'POST',
  url: '/mcp',
  rawBody: Buffer.from('{"jsonrpc":"2.0"}', 'utf8'),
};

describe('InternalSshVerifier', () => {
  it('schickt Header, Body-Hash-Grundlage und Token an /internal/verify-ssh', async () => {
    const fetchImpl = makeFetch(200, { valid: true, projectId: 3, keyName: 'CI' });
    const verifier = new InternalSshVerifier({
      internalUrl: 'http://api:3000/',
      token: 'geheim',
      fetchImpl,
    });

    const result = await verifier.verify(input);
    expect(result).toEqual({ valid: true, projectId: 3, keyName: 'CI' });

    const request = fetchImpl.requests[0]!;
    expect(request.url).toBe('http://api:3000/internal/verify-ssh');
    expect(request.method).toBe('POST');
    expect(request.token).toBe('geheim');
    expect(request.body).toMatchObject({
      keyId: '7',
      timestamp: '1700000000',
      signature: 'c2ln',
      method: 'POST',
      url: '/mcp',
      rawBody: input.rawBody.toString('base64'),
    });
  });

  it('meldet 401 als ungültig statt als Fehler', async () => {
    const verifier = new InternalSshVerifier({
      internalUrl: 'http://api:3000',
      token: 'geheim',
      fetchImpl: makeFetch(401, { valid: false, error: 'Signatur ungültig' }),
    });
    expect(await verifier.verify(input)).toEqual({ valid: false });
  });

  it('wirft bei unerwarteten Statuscodes', async () => {
    const verifier = new InternalSshVerifier({
      internalUrl: 'http://api:3000',
      token: 'geheim',
      fetchImpl: makeFetch(500, { title: 'Internal Server Error' }),
    });
    await expect(verifier.verify(input)).rejects.toThrow(/HTTP 500/);
  });
});
