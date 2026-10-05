import { describe, expect, it } from 'vitest';
import { RestSessionApi } from './rest.js';
import { ApiError } from './types.js';

// ---------------------------------------------------------------------------
// Fetch-Mock-Hilfen
// ---------------------------------------------------------------------------

interface MockRequest {
  url: string;
  method: string;
  path: string;
  cookie: string | null;
  body: string | null;
}

type MockHandler = (request: MockRequest) => Response | Promise<Response>;

interface MockFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  requests: MockRequest[];
}

function makeFetch(handler: MockHandler): MockFetch {
  const requests: MockRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const request: MockRequest = {
      url,
      method: init?.method ?? 'GET',
      path: new URL(url).pathname,
      cookie: new Headers(init?.headers).get('cookie'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    requests.push(request);
    return handler(request);
  }) as MockFetch;
  fetchImpl.requests = requests;
  return fetchImpl;
}

function cookieHeaders(...cookies: string[]): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return headers;
}

function jsonResponse(body: unknown, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers({ 'content-type': 'application/json' });
  return new Response(JSON.stringify(body), { status, headers: h });
}

const LOGIN_COOKIES = [
  'pp_at=access-1; Path=/; HttpOnly',
  'pp_rt=refresh-1; Path=/api/v1/auth; HttpOnly',
];

function createApi(fetchImpl: MockFetch): RestSessionApi {
  return new RestSessionApi({
    baseUrl: 'http://api.test',
    email: 'bot@example.com',
    password: 'geheim-123',
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------

describe('RestSessionApi', () => {
  it('loggt sich beim ersten Request ein und sendet Cookies mit', async () => {
    const fetchImpl = makeFetch((request) => {
      if (request.path === '/api/v1/auth/login') {
        expect(request.method).toBe('POST');
        expect(JSON.parse(request.body!)).toEqual({
          email: 'bot@example.com',
          password: 'geheim-123',
        });
        return jsonResponse({ user: { id: 1 } }, 200, cookieHeaders(...LOGIN_COOKIES));
      }
      if (request.path === '/api/v1/projects') {
        expect(request.cookie).toContain('pp_at=access-1');
        return jsonResponse({ items: [{ id: 1, name: 'Projekt A' }] });
      }
      throw new Error(`Unerwarteter Request: ${request.method} ${request.path}`);
    });

    const api = createApi(fetchImpl);
    const projects = await api.listProjects();

    expect(projects).toEqual([{ id: 1, name: 'Projekt A' }]);
    expect(fetchImpl.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v1/auth/login',
      'GET /api/v1/projects',
    ]);
  });

  it('erneuert bei 401 den Access-Token und wiederholt den Request genau einmal', async () => {
    let projectCalls = 0;
    const fetchImpl = makeFetch((request) => {
      if (request.path === '/api/v1/auth/login') {
        return jsonResponse({ user: { id: 1 } }, 200, cookieHeaders(...LOGIN_COOKIES));
      }
      if (request.path === '/api/v1/auth/refresh') {
        expect(request.method).toBe('POST');
        expect(request.cookie).toContain('pp_rt=refresh-1');
        return jsonResponse(
          { user: { id: 1 } },
          200,
          cookieHeaders('pp_at=access-2', 'pp_rt=refresh-2'),
        );
      }
      if (request.path === '/api/v1/projects') {
        projectCalls += 1;
        if (projectCalls === 1) {
          return jsonResponse({ title: 'Unauthorized', status: 401 }, 401);
        }
        expect(request.cookie).toContain('pp_at=access-2');
        return jsonResponse({ items: [{ id: 2, name: 'Projekt B' }] });
      }
      throw new Error(`Unerwarteter Request: ${request.method} ${request.path}`);
    });

    const api = createApi(fetchImpl);
    expect((await api.listProjects()).map((p) => p.id)).toEqual([2]);
    expect(projectCalls).toBe(2);
    expect(fetchImpl.requests.filter((r) => r.path === '/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('teilt sich parallele Refreshes (Single-Flight)', async () => {
    let refreshCalls = 0;
    let loginCalls = 0;
    const fetchImpl = makeFetch(async (request) => {
      if (request.path === '/api/v1/auth/login') {
        loginCalls += 1;
        return jsonResponse({ user: { id: 1 } }, 200, cookieHeaders(...LOGIN_COOKIES));
      }
      if (request.path === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        // Refresh etwas verzögern, damit beide Requests sicher parallel ankommen.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse(
          { user: { id: 1 } },
          200,
          cookieHeaders('pp_at=access-2', 'pp_rt=refresh-2'),
        );
      }
      if (request.path === '/api/v1/projects') {
        if ((request.cookie ?? '').includes('access-1')) {
          return jsonResponse({ status: 401 }, 401);
        }
        return jsonResponse({ items: [] });
      }
      throw new Error(`Unerwarteter Request: ${request.method} ${request.path}`);
    });

    const api = createApi(fetchImpl);
    await Promise.all([api.listProjects(), api.listProjects()]);

    expect(loginCalls).toBe(1);
    expect(refreshCalls).toBe(1);
  });

  it('fällt bei fehlgeschlagenem Refresh auf einen neuen Login zurück', async () => {
    let logins = 0;
    const fetchImpl = makeFetch((request) => {
      if (request.path === '/api/v1/auth/login') {
        logins += 1;
        return jsonResponse(
          { user: { id: 1 } },
          200,
          cookieHeaders(`pp_at=access-${logins}`, `pp_rt=refresh-${logins}`),
        );
      }
      if (request.path === '/api/v1/auth/refresh') {
        return jsonResponse({ status: 401, detail: 'Refresh abgelaufen' }, 401);
      }
      if (request.path === '/api/v1/projects') {
        if ((request.cookie ?? '').includes('access-1')) {
          return jsonResponse({ status: 401 }, 401);
        }
        return jsonResponse({ items: [{ id: 9, name: 'Nach Login' }] });
      }
      throw new Error(`Unerwarteter Request: ${request.method} ${request.path}`);
    });

    const api = createApi(fetchImpl);
    const projects = await api.listProjects();
    expect(projects.map((p) => p.id)).toEqual([9]);
    expect(logins).toBe(2);
  });

  it('wirft ApiError mit RFC-7807-Details', async () => {
    const fetchImpl = makeFetch((request) => {
      if (request.path === '/api/v1/auth/login') {
        return jsonResponse({ user: { id: 1 } }, 200, cookieHeaders(...LOGIN_COOKIES));
      }
      return jsonResponse(
        {
          type: 'urn:projectplaner:validation',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Validierung fehlgeschlagen',
          errors: [{ path: 'name', message: 'Pflichtfeld' }],
        },
        422,
      );
    });

    const api = createApi(fetchImpl);
    const error = await api
      .createTask(1, { name: '' })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).message).toBe('Validierung fehlgeschlagen');
  });

  it('nutzt die internen Endpunkte für Mutationen', async () => {
    const fetchImpl = makeFetch((request) => {
      if (request.path === '/api/v1/auth/login') {
        return jsonResponse({ user: { id: 1 } }, 200, cookieHeaders(...LOGIN_COOKIES));
      }
      if (request.path === '/api/v1/tasks/5/dependencies') {
        expect(request.method).toBe('POST');
        expect(JSON.parse(request.body!)).toEqual({
          predecessorId: 5,
          successorId: 8,
          type: 'SS',
          lagMinutes: -30,
        });
        return jsonResponse({ dependency: { id: 1, predecessorId: 5, successorId: 8 } }, 201);
      }
      if (request.path === '/api/v1/tasks/9/assignments') {
        return jsonResponse({ assignment: { id: 2, resourceId: 3, allocationPercent: 50 } }, 201);
      }
      if (request.path === '/api/v1/projects/4/schedule') {
        expect(request.method).toBe('POST');
        expect(request.body).toBe('{}');
        return jsonResponse({ result: { projectId: 4, version: 2, taskCount: 10, cyclicCount: 0 } });
      }
      throw new Error(`Unerwarteter Request: ${request.method} ${request.path}`);
    });

    const api = createApi(fetchImpl);
    await api.addDependency(4, {
      predecessorId: 5,
      successorId: 8,
      type: 'SS',
      lagMinutes: -30,
    });
    await api.assignResource(4, 9, { resourceId: 3, allocationPercent: 50 });
    const scheduled = await api.computeSchedule(4);
    expect(scheduled.result.taskCount).toBe(10);
  });

  it('baut Gantt-Query-Parameter korrekt auf', async () => {
    const fetchImpl = makeFetch((request) => {
      if (request.path === '/api/v1/auth/login') {
        return jsonResponse({ user: { id: 1 } }, 200, cookieHeaders(...LOGIN_COOKIES));
      }
      if (request.path === '/api/v1/projects/2/gantt') {
        expect(request.url).toContain('from=2026-01-01T00%3A00%3A00Z');
        expect(request.url).toContain('to=2026-02-01T00%3A00%3A00Z');
        return jsonResponse({ project: { id: 2 }, tasks: [] });
      }
      throw new Error(`Unerwarteter Request: ${request.method} ${request.path}`);
    });

    const api = createApi(fetchImpl);
    await api.getGantt(2, { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' });
  });
});
