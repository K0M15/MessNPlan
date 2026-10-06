import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../server.js';
import type { TaskApi } from '../api/types.js';
import type { SshVerifier } from '../http/verify.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MCP_PATH = '/mcp';
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;

export interface HttpRateLimitOptions {
  /** Max. verifizierte Requests je API-Schlüssel und Fenster (Default 60). */
  maxRequests?: number;
  /** Länge des gleitenden Fensters in ms (Default 60_000). */
  windowMs?: number;
}

export interface StartHttpServerOptions {
  host: string;
  port: number;
  api: TaskApi;
  verifier: SshVerifier;
  /** Rate-Limit je verifiziertem API-Schlüssel (Default 60 Requests/Minute). */
  rateLimit?: HttpRateLimitOptions;
  /** Idle-Timeout für `mcp-session-id` (Default 30 Minuten). */
  sessionIdleTimeoutMs?: number;
  /** Testbare Uhr (Default `Date.now`). */
  now?: () => number;
}

export interface RunningHttpServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request-Body zu groß');
    this.name = 'BodyTooLargeError';
  }
}

/** Verifizierter Schlüsselkontext eines MCP-Requests. */
interface VerifiedKeyContext {
  /** Auf Ziffern normalisierte ID des verifizierten API-Schlüssels. */
  keyId: string;
  /** Projektbindung des Schlüssels aus `/internal/verify-ssh`. */
  projectId?: number;
}

/**
 * In-Memory-Session. `mcp-session-id` ist an den Schlüssel gebunden, der die
 * Session initialisiert hat; `projectId` beschränkt die Tools auf ein Projekt.
 */
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  keyId: string;
  projectId?: number;
  createdAt: number;
  lastSeen: number;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value[0] : value)?.trim();
}

function sendProblem(
  res: ServerResponse,
  status: number,
  title: string,
  detail?: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({
    type: `urn:projectplaner:${status === 401 ? 'unauthorized' : 'http-error'}`,
    title,
    status,
    ...(detail ? { detail } : {}),
  });
  res.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' });
  res.end(body);
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Startet den MCP-Server als Streamable-HTTP-Endpunkt unter `/mcp`.
 *
 * Jeder Request (POST/GET/DELETE) muss mit den drei SSH-Headern signiert sein:
 * `x-pp-key-id`, `x-pp-timestamp`, `x-pp-signature`. Die Prüfung läuft über
 * den internen API-Endpunkt `POST /internal/verify-ssh` – der MCP-Server
 * implementiert die Signaturlogik nicht selbst.
 *
 * Der verifizierte Schlüsselkontext wird an die Session gebunden:
 * `mcp-session-id` kann nur vom selben Schlüssel genutzt werden, und die
 * Projektbindung des Schlüssels schränkt alle Tool-Aufrufe ein. Zusätzlich
 * gilt ein In-Memory-Rate-Limit (Standard 60 Requests/Minute je Schlüssel)
 * und ein Idle-Timeout für Sessions (Standard 30 Minuten).
 */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const now = options.now ?? Date.now;
  const rateLimitWindowMs = options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const rateLimitMaxRequests = options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;

  const sessions = new Map<string, SessionEntry>();
  /** Request-Timestamps je verifizierter Key-ID (gleitendes Fenster). */
  const requestLog = new Map<string, number[]>();

  function checkRateLimit(
    keyId: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const nowMs = now();
    const cutoff = nowMs - rateLimitWindowMs;
    const recent = (requestLog.get(keyId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= rateLimitMaxRequests) {
      requestLog.set(keyId, recent);
      const retryMs = Math.max(1, recent[0]! + rateLimitWindowMs - nowMs);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryMs / 1000) };
    }
    recent.push(nowMs);
    requestLog.set(keyId, recent);
    return { allowed: true };
  }

  function closeSession(sessionId: string, session: SessionEntry): void {
    sessions.delete(sessionId);
    void session.transport.close().catch(() => undefined);
  }

  function sessionExpired(session: SessionEntry): boolean {
    return now() - session.lastSeen > sessionIdleTimeoutMs;
  }

  function getSession(sessionId: string): SessionEntry | undefined {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    if (sessionExpired(session)) {
      closeSession(sessionId, session);
      return undefined;
    }
    return session;
  }

  const sweepTimer = setInterval(() => {
    for (const [sessionId, session] of sessions) {
      if (sessionExpired(session)) closeSession(sessionId, session);
    }
    const cutoff = now() - rateLimitWindowMs;
    for (const [keyId, timestamps] of requestLog) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length === 0) requestLog.delete(keyId);
      else requestLog.set(keyId, recent);
    }
  }, Math.max(1, Math.min(SESSION_SWEEP_INTERVAL_MS, sessionIdleTimeoutMs)));
  sweepTimer.unref();

  async function verifyIncoming(
    req: IncomingMessage,
    rawBody: Buffer,
  ): Promise<
    { ok: true; auth: VerifiedKeyContext } | { ok: false; status: number; detail: string }
  > {
    const keyId = singleHeader(req.headers['x-pp-key-id']);
    const timestamp = singleHeader(req.headers['x-pp-timestamp']);
    const signature = singleHeader(req.headers['x-pp-signature']);
    if (!keyId || !timestamp || !signature) {
      return {
        ok: false,
        status: 401,
        detail: 'SSH-Header fehlen (x-pp-key-id, x-pp-timestamp, x-pp-signature)',
      };
    }

    try {
      const result = await options.verifier.verify({
        keyId,
        timestamp,
        signature,
        method: req.method ?? 'GET',
        url: req.url ?? MCP_PATH,
        rawBody,
      });
      if (!result.valid) return { ok: false, status: 401, detail: 'SSH-Signatur ungültig' };
      return {
        ok: true,
        auth: {
          // Die Header-Key-ID ist Teil des signierten kanonischen Strings und
          // damit durch die Verifikation bestätigt; auf Ziffern normalisieren.
          keyId: /^\d+$/.test(keyId) ? String(Number(keyId)) : keyId,
          ...(typeof result.projectId === 'number' ? { projectId: result.projectId } : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        detail: `SSH-Verifikation nicht möglich: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
    auth: VerifiedKeyContext,
  ): Promise<void> {
    const sessionIdRaw = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;

    if (sessionId) {
      const session = getSession(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      if (session.keyId !== auth.keyId) {
        sendProblem(
          res,
          403,
          'Forbidden',
          'mcp-session-id gehört zu einem anderen API-Schlüssel – neue Session initialisieren',
        );
        return;
      }
      if (
        session.projectId !== undefined &&
        auth.projectId !== undefined &&
        session.projectId !== auth.projectId
      ) {
        sendProblem(
          res,
          403,
          'Forbidden',
          'Projektbindung der Session stimmt nicht mit dem verifizierten API-Schlüssel überein',
        );
        return;
      }
      session.lastSeen = now();
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, {
          transport,
          keyId: auth.keyId,
          ...(auth.projectId !== undefined ? { projectId: auth.projectId } : {}),
          createdAt: now(),
          lastSeen: now(),
        });
      },
    });
    transport.onclose = () => {
      const closedId = transport.sessionId;
      if (closedId) sessions.delete(closedId);
    };

    // Projektbindung des verifizierten Schlüssels: Die Tools dürfen nur noch
    // dieses Projekt adressieren (harte Prüfung in der Tool-Schicht).
    const mcpServer = createMcpServer(
      options.api,
      auth.projectId !== undefined ? { boundProjectId: auth.projectId } : {},
    );
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'content-type, mcp-session-id, mcp-protocol-version, last-event-id, ' +
          'x-pp-key-id, x-pp-timestamp, x-pp-signature',
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return;
    }

    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (path !== MCP_PATH) {
      sendProblem(res, 404, 'Not Found', `Unbekannter Pfad "${path}" (MCP-Endpunkt: ${MCP_PATH})`);
      return;
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      sendProblem(res, 405, 'Method Not Allowed');
      return;
    }

    let rawBody: Buffer = Buffer.alloc(0);
    if (req.method === 'POST') {
      try {
        rawBody = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendProblem(res, 413, 'Payload Too Large', error.message);
          return;
        }
        throw error;
      }
    }

    const auth = await verifyIncoming(req, rawBody);
    if (!auth.ok) {
      sendProblem(res, auth.status, auth.status === 401 ? 'Unauthorized' : 'Bad Gateway', auth.detail);
      return;
    }

    const limit = checkRateLimit(auth.auth.keyId);
    if (!limit.allowed) {
      res.setHeader('retry-after', String(limit.retryAfterSeconds));
      sendProblem(
        res,
        429,
        'Too Many Requests',
        `Zu viele Requests für diesen API-Schlüssel – in ${limit.retryAfterSeconds} s erneut ` +
          `versuchen (max. ${rateLimitMaxRequests}/${Math.round(rateLimitWindowMs / 1000)} s)`,
      );
      return;
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      if (rawBody.length === 0) {
        sendJsonRpcError(res, 400, -32600, 'Invalid Request: leerer Body');
        return;
      }
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJsonRpcError(res, 400, -32700, 'Parse error: ungültiges JSON');
        return;
      }
    }

    await dispatch(req, res, parsedBody, auth.auth);
  }

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      sendProblem(
        res,
        500,
        'Internal Server Error',
        error instanceof Error ? error.message : String(error),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort =
    address !== null && typeof address === 'object' ? address.port : options.port;

  return {
    server: httpServer,
    port: boundPort,
    async close(): Promise<void> {
      clearInterval(sweepTimer);
      await Promise.all(
        [...sessions.values()].map((session) =>
          session.transport.close().catch(() => undefined),
        ),
      );
      sessions.clear();
      requestLog.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
