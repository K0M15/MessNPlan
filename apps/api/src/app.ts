import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { allowedOrigins, config, trustProxy } from './config.js';
import { pingDatabase } from './db/client.js';
import { ApiError } from './errors.js';
import { originCheck } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';
import { authenticateSshRequest } from './http/sshAuth.js';
import { logger } from './logger.js';
import { broadcastToProject } from './realtime.js';
import { metricsHandler, metricsMiddleware } from './services/metrics.js';
import { apiKeyRoutes } from './routes/apiKeys.js';
import { assignmentRoutes } from './routes/assignments.js';
import { authRoutes } from './routes/auth.js';
import { externalRoutes } from './routes/external.js';
import { commentRoutes } from './routes/comments.js';
import { dependencyRoutes } from './routes/dependencies.js';
import { projectRoutes } from './routes/projects.js';
import { resourceRoutes } from './routes/resources.js';
import { outlookRoutes } from './routes/outlook.js';
import { scheduleRoutes } from './routes/schedule.js';
import { tagRoutes } from './routes/tags.js';
import { taskRoutes } from './routes/tasks.js';
import { userRoutes } from './routes/users.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use(
    helmet({
      // CSP wird für die SPA von Caddy gesetzt; die API liefert nur JSON.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) =>
        (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      autoLogging: {
        ignore: (req) =>
          req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
      },
    }),
  );
  // Metriken früh einhängen, damit alle Requests erfasst werden (auch 4xx/5xx).
  app.use(metricsMiddleware);
  app.use(
    express.json({
      limit: '1mb',
      // Rohen Body nur referenzieren (kein Copy) – die externe SSH-API
      // signiert sha256(rawBody) und braucht die exakten Bytes.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());
  app.use(originCheck);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/readyz', async (_req, res) => {
    const dbOk = await pingDatabase();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'unavailable',
      checks: { database: dbOk },
    });
  });

  // Prometheus-Scrape-Endpunkt. Bewusst NICHT öffentlich: Caddy leitet nur
  // /api/* und /socket.io/* an die API weiter, /metrics wird nicht exponiert.
  // Scrape daher intern (z. B. http://api:3000/metrics im Docker-Netz),
  // siehe docs/operations/monitoring.md.
  app.get('/metrics', metricsHandler);

  const api = express.Router();
  api.use('/auth', authRoutes());
  api.use('/users', userRoutes());
  api.use('/projects', projectRoutes());
  // Externe API mit eigener SSH-Key-Authentifizierung – vor den internen
  // Sammlern mounten, die auf '/' liegen und intern `requireAuth` setzen.
  api.use('/external', externalRoutes());
  api.use('/', apiKeyRoutes());
  // ACHTUNG Reihenfolge: Die folgenden Router sind auf '/' gemountet und nutzen
  // intern `router.use(requireAuth)` als Gate. Öffentliche Routen (z. B. der
  // Outlook-OAuth-Callback, den Microsoft cross-site aufruft) müssen deshalb
  // VOR diesen Sammel-Routern registriert sein.
  api.use('/', outlookRoutes());
  api.use('/', taskRoutes());
  api.use('/', dependencyRoutes());
  api.use('/', resourceRoutes());
  api.use('/', assignmentRoutes());
  api.use('/', tagRoutes());
  api.use('/', commentRoutes());
  api.use('/', scheduleRoutes());

  app.use('/api/v1', api);
  app.use('/api', notFoundHandler);

  // Interne Endpunkte für Worker und MCP-Server (Token = JWT_SECRET).
  const internalTokenValid = (req: express.Request): boolean => {
    const provided = String(req.headers['x-internal-token'] ?? '');
    const providedHash = createHash('sha256').update(provided).digest();
    const expectedHash = createHash('sha256').update(config.JWT_SECRET).digest();
    return timingSafeEqual(providedHash, expectedHash);
  };

  app.post('/internal/broadcast', (req, res) => {
    if (!internalTokenValid(req)) {
      res.status(403).json({ type: 'urn:projectplaner:forbidden', title: 'Forbidden', status: 403 });
      return;
    }
    const body = req.body as { projectId?: unknown; event?: unknown; payload?: unknown };
    const projectId = Number(body.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0 || typeof body.event !== 'string') {
      res.status(400).json({ type: 'urn:projectplaner:bad-request', title: 'Bad Request', status: 400 });
      return;
    }
    broadcastToProject(projectId, body.event, body.payload);
    res.status(204).end();
  });

  // Der MCP-Server (Streamable HTTP) prüft Signaturen eingehender MCP-Requests
  // nicht selbst, sondern reicht Header + rohen Body hierher durch. Damit
  // existiert die SSH-Verifikation (Key-Lookup, Ablauf, Replay, Signatur) nur
  // einmal – in `authenticateSshRequest` (http/sshAuth.ts).
  const verifySshSchema = z.object({
    keyId: z.string().min(1).max(64),
    timestamp: z.string().min(1).max(64),
    signature: z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 erwartet'),
    method: z.string().min(1).max(16),
    url: z.string().min(1).max(2_048),
    rawBody: z.string().max(6_000_000).default(''),
  });

  app.post('/internal/verify-ssh', async (req, res) => {
    if (!internalTokenValid(req)) {
      res.status(403).json({ type: 'urn:projectplaner:forbidden', title: 'Forbidden', status: 403 });
      return;
    }
    const parsed = verifySshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ valid: false, error: 'Ungültiger Verify-Request' });
      return;
    }

    try {
      const key = await authenticateSshRequest({
        keyId: parsed.data.keyId,
        timestamp: parsed.data.timestamp,
        signature: parsed.data.signature,
        method: parsed.data.method,
        url: parsed.data.url,
        rawBody: Buffer.from(parsed.data.rawBody, 'base64'),
      });
      res.json({ valid: true, projectId: key.projectId, keyName: key.name });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        res.status(401).json({ valid: false, error: error.message });
        return;
      }
      throw error;
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
