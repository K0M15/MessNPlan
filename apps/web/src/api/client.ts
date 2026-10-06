import type { ProblemDetails } from '@projectplaner/shared';

export class ApiClientError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;

  constructor(status: number, problem: ProblemDetails | null) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.problem = problem;
  }
}

const BASE = '/api/v1';

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight Refresh: parallele 401er lösen genau einen Refresh aus. */
async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function doFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('json') ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    throw new ApiClientError(response.status, data as ProblemDetails | null);
  }
  return data as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await doFetch(path, init);

  if (response.status === 401 && !path.startsWith('/auth/')) {
    if (await tryRefresh()) {
      window.dispatchEvent(new Event('pp:auth-refreshed'));
      return request<T>(path, init); // genau ein Replay nach erfolgreichem Refresh
    }
    window.dispatchEvent(new Event('pp:auth-expired'));
    window.location.assign('/login');
    throw new ApiClientError(401, null);
  }

  return handleResponse<T>(response);
}

export interface ConditionalResult<T> {
  notModified: boolean;
  data?: T;
  etag?: string;
}

/**
 * GET mit ETag: Sendet `If-None-Match` und behandelt 304 als „unverändert“,
 * damit unveränderte Schedule-Payloads nicht erneut übertragen werden.
 */
async function requestConditional<T>(
  path: string,
  etag: string | null,
): Promise<ConditionalResult<T>> {
  const init: RequestInit = etag ? { headers: { 'If-None-Match': etag } } : {};
  let response = await doFetch(path, init);

  if (response.status === 401) {
    if (await tryRefresh()) {
      window.dispatchEvent(new Event('pp:auth-refreshed'));
      response = await doFetch(path, init);
    } else {
      window.dispatchEvent(new Event('pp:auth-expired'));
      window.location.assign('/login');
      throw new ApiClientError(401, null);
    }
  }

  if (response.status === 304) {
    return { notModified: true, etag: etag ?? undefined };
  }

  const data = await handleResponse<T>(response);
  return {
    notModified: false,
    data,
    etag: response.headers.get('etag') ?? undefined,
  };
}

export interface RequestOptions {
  /** Optimistic-Locking-Version → If-Match-Header. */
  version?: number;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getConditional: <T>(path: string, etag: string | null) => requestConditional<T>(path, etag),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(options?.version !== undefined ? { headers: { 'If-Match': String(options.version) } } : {}),
    }),
  patch: <T>(path: string, body: unknown, version?: number) =>
    request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
      ...(version !== undefined ? { headers: { 'If-Match': String(version) } } : {}),
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T = void>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'DELETE',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};
