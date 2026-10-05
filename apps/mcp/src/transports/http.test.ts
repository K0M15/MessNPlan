import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, type RunningHttpServer } from './http.js';
import type { SshVerifyInput, SshVerifier } from '../http/verify.js';
import type { TaskApi } from '../api/types.js';

/** Fake-API: tools/list ruft keine Handler auf. */
function unusedApi(): TaskApi {
  const unused = async () => {
    throw new Error('API im Transport-Test nicht verwendet');
  };
  return {
    kind: 'rest',
    listProjects: unused,
    getProject: unused,
    listTasks: unused,
    listResources: unused,
    createTask: unused,
    addDependency: unused,
    assignResource: unused,
    computeSchedule: unused,
    getHealth: unused,
    getGantt: unused,
  };
}

function stubVerifier(): SshVerifier & { calls: SshVerifyInput[] } {
  const calls: SshVerifyInput[] = [];
  return {
    calls,
    verify: async (input) => {
      calls.push(input);
      return { valid: input.keyId === '1' && input.signature === 'gültig' };
    },
  };
}

function signedFetch(keyId: string, signature: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('x-pp-key-id', keyId);
    headers.set('x-pp-timestamp', String(Math.floor(Date.now() / 1000)));
    headers.set('x-pp-signature', signature);
    return fetch(input as string | URL, { ...init, headers });
  }) as typeof fetch;
}

async function withServer(
  fn: (options: { running: RunningHttpServer; baseUrl: string; verifier: ReturnType<typeof stubVerifier> }) => Promise<void>,
): Promise<void> {
  const verifier = stubVerifier();
  const running = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    api: unusedApi(),
    verifier,
  });
  try {
    await fn({ running, baseUrl: `http://127.0.0.1:${running.port}`, verifier });
  } finally {
    await running.close();
  }
}

describe('Streamable-HTTP-Transport', () => {
  it('antwortet auf /healthz', async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    });
  });

  it('lehnt Requests ohne SSH-Header mit 401 ab', async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      const problem = (await response.json()) as { detail?: string };
      expect(problem.detail).toContain('SSH-Header');
    });
  });

  it('lehnt ungültige Signaturen mit 401 ab', async () => {
    await withServer(async ({ baseUrl, verifier }) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pp-key-id': '1',
          'x-pp-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-pp-signature': 'ungültig',
        },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(verifier.calls).toHaveLength(1);
    });
  });

  it('erlaubt einem signierten SDK-Client initialize und tools/list', async () => {
    await withServer(async ({ baseUrl, verifier }) => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        fetch: signedFetch('1', 'gültig'),
      });
      const client = new Client({ name: 'http-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(9);
        expect(verifier.calls.length).toBeGreaterThan(0);
        // Der interne Verifier bekommt den rohen Body des MCP-Requests.
        const initializeCall = verifier.calls.find((call) => call.rawBody.length > 0);
        expect(initializeCall?.url.split('?')[0]).toBe('/mcp');
        expect(initializeCall?.method).toBe('POST');
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  });

  it('weist ungültige Signaturen auch für SDK-Clients ab', async () => {
    await withServer(async ({ baseUrl }) => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        fetch: signedFetch('1', 'ungültig'),
      });
      const client = new Client({ name: 'http-test', version: '1.0.0' });
      await expect(client.connect(transport)).rejects.toThrow();
      await client.close().catch(() => undefined);
    });
  });

  it('beantwortet OPTIONS (CORS-Preflight) ohne Auth', async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    });
  });

  it('weist unbekannte Pfade mit 404 ab', async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/unbekannt`);
      expect(response.status).toBe(404);
    });
  });

  it('prüft die Methode (405)', async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/mcp`, { method: 'PUT' });
      expect(response.status).toBe(405);
    });
  });
});
