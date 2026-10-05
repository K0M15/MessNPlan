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

export interface StartHttpServerOptions {
  host: string;
  port: number;
  api: TaskApi;
  verifier: SshVerifier;
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
 */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function verifyIncoming(
    req: IncomingMessage,
    rawBody: Buffer,
  ): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
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
      return { ok: true };
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
  ): Promise<void> {
    const sessionIdRaw = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;

    if (sessionId) {
      const existing = transports.get(sessionId);
      if (!existing) {
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await existing.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
      },
    });
    transport.onclose = () => {
      const closedId = transport.sessionId;
      if (closedId) transports.delete(closedId);
    };

    const mcpServer = createMcpServer(options.api);
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

    await dispatch(req, res, parsedBody);
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
      await Promise.all(
        [...transports.values()].map((transport) =>
          transport.close().catch(() => undefined),
        ),
      );
      transports.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
