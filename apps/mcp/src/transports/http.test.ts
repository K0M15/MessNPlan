import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  startHttpServer,
  type HttpRateLimitOptions,
  type RunningHttpServer,
} from './http.js';
import type { SshVerifyInput, SshVerifier } from '../http/verify.js';
import type { ProjectDto, TaskApi, TaskDto } from '../api/types.js';

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

/** Fake-API mit zwei Projekten für die Projektbindungs-Tests. */
function projectApi() {
  function project(id: number, name: string): ProjectDto {
    return { id, name, status: 'active', timezone: 'Europe/Berlin', version: 1 };
  }
  const createTask = vi.fn(async (projectId: number, input: { name: string }): Promise<{ task: TaskDto }> => ({
    task: {
      id: 99,
      projectId,
      parentId: null,
      name: input.name,
      estimatedMinutes: null,
      status: 'todo',
      constraintType: 'asap',
      isMilestone: false,
    },
  }));
  const api: TaskApi = {
    kind: 'rest',
    listProjects: async () => [project(1, 'Projekt A'), project(2, 'Projekt B')],
    getProject: async (id: number) => ({ project: project(id, `Projekt ${id}`), members: [] }),
    listTasks: async () => [],
    listResources: async () => [],
    createTask,
    addDependency: async () => ({ dependency: { id: 1, predecessorId: 1, successorId: 2, type: 'FS', lagMinutes: 0 } }),
    assignResource: async () => ({ assignment: { id: 1, resourceId: 5, allocationPercent: 100 } }),
    computeSchedule: async () => ({
      result: { projectId: 1, version: 2, taskCount: 0, cyclicCount: 0, computedAt: 'x' },
    }),
    getHealth: async () => ({ issues: [], summary: { error: 0, warning: 0, info: 0, total: 0 } }),
    getGantt: async () => {
      throw new Error('getGantt im Transport-Test nicht verwendet');
    },
  };
  return { api, createTask };
}

interface StubKeyConfig {
  projectId?: number;
  keyName?: string;
}

function stubVerifier(validKeys: Record<string, StubKeyConfig> = { '1': {} }): SshVerifier & {
  calls: SshVerifyInput[];
} {
  const calls: SshVerifyInput[] = [];
  return {
    calls,
    verify: async (input) => {
      calls.push(input);
      const key = validKeys[input.keyId];
      if (!key || input.signature !== 'gültig') return { valid: false };
      return {
        valid: true,
        ...(key.projectId !== undefined ? { projectId: key.projectId } : {}),
        ...(key.keyName !== undefined ? { keyName: key.keyName } : {}),
      };
    },
  };
}

function sshHeaders(keyId: string, signature = 'gültig'): Record<string, string> {
  return {
    'x-pp-key-id': keyId,
    'x-pp-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-pp-signature': signature,
  };
}

function signedFetch(keyId: string, signature: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(sshHeaders(keyId, signature))) {
      headers.set(name, value);
    }
    return fetch(input as string | URL, { ...init, headers });
  }) as typeof fetch;
}

interface WithServerContext {
  running: RunningHttpServer;
  baseUrl: string;
  verifier: ReturnType<typeof stubVerifier>;
  /** Verschiebt die vom Server genutzte Test-Uhr. */
  advanceTime(ms: number): void;
}

interface WithServerSetup {
  api?: TaskApi;
  verifier?: ReturnType<typeof stubVerifier>;
  rateLimit?: HttpRateLimitOptions;
  sessionIdleTimeoutMs?: number;
}

async function withServer(
  fn: (options: WithServerContext) => Promise<void>,
  setup: WithServerSetup = {},
): Promise<void> {
  const verifier = setup.verifier ?? stubVerifier();
  let nowMs = Date.now();
  const running = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    api: setup.api ?? unusedApi(),
    verifier,
    now: () => nowMs,
    ...(setup.rateLimit ? { rateLimit: setup.rateLimit } : {}),
    ...(setup.sessionIdleTimeoutMs !== undefined
      ? { sessionIdleTimeoutMs: setup.sessionIdleTimeoutMs }
      : {}),
  });
  try {
    await fn({
      running,
      baseUrl: `http://127.0.0.1:${running.port}`,
      verifier,
      advanceTime: (ms) => {
        nowMs += ms;
      },
    });
  } finally {
    await running.close();
  }
}

async function connectClient(baseUrl: string, keyId: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    fetch: signedFetch(keyId, 'gültig'),
  });
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
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

  it('weist unbekannte/abgelaufene Session-IDs mit 404 ab', async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          ...sshHeaders('1'),
          'content-type': 'application/json',
          'mcp-session-id': 'unbekannt',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(404);
      const error = (await response.json()) as { error?: { message?: string } };
      expect(error.error?.message).toBe('Session not found');
    });
  });

  it('bindet mcp-session-id an den erzeugenden API-Schlüssel (403 für fremden Key)', async () => {
    const verifier = stubVerifier({ '1': { projectId: 1 }, '2': { projectId: 2 } });
    await withServer(
      async ({ baseUrl }) => {
        const { client, transport } = await connectClient(baseUrl, '1');
        const sessionId = transport.sessionId;
        expect(sessionId).toBeTruthy();

        const response = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            ...sshHeaders('2'),
            'content-type': 'application/json',
            'mcp-session-id': sessionId!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        });
        expect(response.status).toBe(403);
        const problem = (await response.json()) as { detail?: string };
        expect(problem.detail).toContain('anderen API-Schlüssel');

        await client.close().catch(() => undefined);
      },
      { verifier },
    );
  });

  it('weist Sessions nach dem Idle-Timeout mit 404 ab', async () => {
    await withServer(
      async ({ baseUrl, advanceTime }) => {
        const { client, transport } = await connectClient(baseUrl, '1');
        const sessionId = transport.sessionId;
        expect(sessionId).toBeTruthy();

        advanceTime(31 * 60_000);
        const response = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            ...sshHeaders('1'),
            'content-type': 'application/json',
            'mcp-session-id': sessionId!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        });
        expect(response.status).toBe(404);

        await client.close().catch(() => undefined);
      },
      { sessionIdleTimeoutMs: 30 * 60_000 },
    );
  });

  it('begrenzt Requests je API-Schlüssel (429 mit Retry-After)', async () => {
    const verifier = stubVerifier({ '1': { projectId: 1 }, '2': { projectId: 2 } });
    await withServer(
      async ({ baseUrl }) => {
        const request = (keyId: string) =>
          fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              ...sshHeaders(keyId),
              'content-type': 'application/json',
              'mcp-session-id': 'unbekannt',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          });

        for (let i = 0; i < 3; i += 1) {
          expect((await request('1')).status).toBe(404);
        }
        const blocked = await request('1');
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
        const problem = (await blocked.json()) as { detail?: string };
        expect(problem.detail).toContain('Zu viele Requests');

        // Ein anderer Schlüssel hat sein eigenes Kontingent.
        expect((await request('2')).status).toBe(404);
      },
      { verifier, rateLimit: { maxRequests: 3, windowMs: 60_000 } },
    );
  });

  it('erzwingt die Projektbindung des Schlüssels in den Tools', async () => {
    const { api, createTask } = projectApi();
    const verifier = stubVerifier({ '1': { projectId: 1 } });
    await withServer(
      async ({ baseUrl }) => {
        const { client } = await connectClient(baseUrl, '1');
        try {
          // list_projects liefert nur das gebundene Projekt.
          const projects = (await client.callTool({
            name: 'list_projects',
            arguments: {},
          })) as { content: Array<{ type: string; text?: string }> };
          const projectsText = projects.content[0]?.text ?? '';
          expect(projectsText).toContain('"id":1');
          expect(projectsText).not.toContain('"id":2');

          // Fremdes Projekt → Tool-Fehler, keine API-Mutation.
          const foreign = (await client.callTool({
            name: 'create_task',
            arguments: { projectId: 2, name: 'Fremd' },
          })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
          expect(foreign.isError).toBe(true);
          expect(foreign.content[0]?.text).toContain('beschränkt');
          expect(createTask).not.toHaveBeenCalled();

          // Ohne projectId wird das gebundene Projekt vorbelegt.
          const created = (await client.callTool({
            name: 'create_task',
            arguments: { name: 'Neu' },
          })) as { isError?: boolean };
          expect(created.isError).toBeFalsy();
          expect(createTask).toHaveBeenCalledWith(1, { name: 'Neu' });
        } finally {
          await client.close().catch(() => undefined);
        }
      },
      { api, verifier },
    );
  });
});
