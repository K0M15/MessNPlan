import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { outlookConnectionUpdateSchema } from '@projectplaner/shared';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { outlookConnections, resources } from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireAuth, type AuthUser } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { ensureProjectAccess } from '../services/access.js';
import { encryptionAvailable } from '../services/crypto.js';
import { buildAuthorizeUrl, exchangeCodeForTokens, generatePkce, graphConfigured } from '../services/graph.js';
import { enqueueJob } from '../services/outbox.js';
import { deleteConnectionWithEvents, mailboxOf, storeConnectionTokens } from '../services/outlookSync.js';

const stateSecret = new TextEncoder().encode(config.JWT_SECRET);

const OUTLOOK_STATE_COOKIE = 'pp_oauth_state';
const OUTLOOK_STATE_PATH = '/api/v1/integrations/outlook';

interface StatePayload {
  userId: number;
  resourceId: number | null;
  projectId: number | null;
  verifier: string;
  nonce: string;
}

function stateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.COOKIE_SECURE,
    path: OUTLOOK_STATE_PATH,
    maxAge: 10 * 60 * 1000,
  };
}

/** Bindet den OAuth-Flow an den Browser, der ihn gestartet hat (CSRF-Schutz). */
function nonceMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function signState(payload: StatePayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(stateSecret);
}

async function verifyState(token: string): Promise<StatePayload | null> {
  try {
    const { payload } = await jwtVerify(token, stateSecret);
    return {
      userId: Number(payload.userId),
      resourceId: payload.resourceId === null || payload.resourceId === undefined ? null : Number(payload.resourceId),
      projectId: payload.projectId === null || payload.projectId === undefined ? null : Number(payload.projectId),
      verifier: String(payload.verifier ?? ''),
      nonce: String(payload.nonce ?? ''),
    };
  } catch {
    return null;
  }
}

type ConnectionRow = typeof outlookConnections.$inferSelect;

/** Sichere DTO ohne Token-Felder. */
function toConnectionDto(connection: ConnectionRow) {
  return {
    id: connection.id,
    userId: connection.userId,
    resourceId: connection.resourceId,
    mailbox: connection.mailbox,
    status: connection.status,
    syncEnabled: connection.syncEnabled,
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

async function ensureConnectionAccess(
  connection: typeof outlookConnections.$inferSelect,
  user: AuthUser,
  minRole: 'planner' | 'member' = 'planner',
): Promise<void> {
  if (user.role === 'admin') return;
  if (connection.userId === user.id) return;
  if (connection.resourceId) {
    const [resource] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, connection.resourceId))
      .limit(1);
    if (resource) {
      await ensureProjectAccess(resource.projectId, user, roleForMember(minRole));
      return;
    }
  }
  throw forbidden('Keine Berechtigung für diese Outlook-Verbindung');
}

function roleForMember(minRole: 'planner' | 'member'): 'planner' | 'member' {
  return minRole === 'planner' ? 'planner' : 'member';
}

function redirect(res: Response, path: string, params: Record<string, string>): void {
  const base = config.APP_ORIGIN.replace(/\/$/, '');
  const query = new URLSearchParams(params).toString();
  res.redirect(302, `${base}${path}${query ? `?${query}` : ''}`);
}

export function outlookRoutes(): Router {
  const router = Router();

  // Browser-Redirect von Microsoft. WICHTIG: Diese Route liegt bewusst VOR dem
  // Auth-Gate – bei der Cross-Site-Navigation von Microsoft werden
  // SameSite=Strict-Cookies (Access-Token) nicht gesendet. Die Authentizität
  // kommt aus dem signierten State-Token (10 min) plus Nonce-Cookie (Lax).
  router.get('/integrations/outlook/callback', async (req, res) => {
    const error = typeof req.query.error === 'string' ? req.query.error : null;
    if (error) {
      redirect(res, '/', { outlook: 'error', reason: error });
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const stateToken = typeof req.query.state === 'string' ? req.query.state : null;
    const state = stateToken ? await verifyState(stateToken) : null;
    const projectPath = state?.projectId ? `/projects/${state.projectId}` : '/';

    const browserNonce = (req.cookies as Record<string, string> | undefined)?.[
      OUTLOOK_STATE_COOKIE
    ];
    res.clearCookie(OUTLOOK_STATE_COOKIE, stateCookieOptions());

    if (!code || !state) {
      redirect(res, projectPath, { outlook: 'error', reason: 'invalid_state' });
      return;
    }
    if (!nonceMatches(browserNonce, state.nonce)) {
      redirect(res, projectPath, { outlook: 'error', reason: 'state_mismatch' });
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code, state.verifier);
      const mailbox = await mailboxOf(tokens.accessToken);

      const existing = state.resourceId
        ? (await db.select().from(outlookConnections).where(eq(outlookConnections.resourceId, state.resourceId)).limit(1))[0]
        : (await db.select().from(outlookConnections).where(eq(outlookConnections.userId, state.userId)).limit(1))[0];

      let connectionId: number;
      if (existing) {
        connectionId = existing.id;
        await db
          .update(outlookConnections)
          .set({ userId: state.userId, resourceId: state.resourceId, updatedAt: new Date() })
          .where(eq(outlookConnections.id, existing.id));
      } else {
        const [created] = await db
          .insert(outlookConnections)
          .values({
            userId: state.userId,
            resourceId: state.resourceId,
            mailbox,
          })
          .$returningId();
        connectionId = created!.id;
      }

      await storeConnectionTokens(connectionId, tokens, mailbox);
      await enqueueJob('outlook.sync', { reason: 'connection-created' }, { runAt: new Date(Date.now() + 1_000) });
      redirect(res, projectPath, { outlook: 'connected' });
    } catch {
      redirect(res, projectPath, { outlook: 'error', reason: 'token_exchange_failed' });
    }
  });

  // Alle weiteren Outlook-Routen benötigen eine Session. Das Gate ist auf die
  // Outlook-Pfade beschränkt, damit dieser Router gefahrlos vor den anderen
  // '/'-gemounteten Routern liegen kann (siehe app.ts).
  router.use(['/integrations/outlook', '/projects/:projectId/outlook'], requireAuth);

  router.get('/integrations/outlook/connect', async (req, res) => {
    if (!graphConfigured()) {
      throw badRequest('Outlook ist nicht konfiguriert (GRAPH_CLIENT_ID/GRAPH_REDIRECT_URI fehlen)');
    }
    if (!encryptionAvailable()) {
      throw badRequest('APP_ENCRYPTION_KEY fehlt – Tokens können nicht sicher gespeichert werden');
    }

    const resourceId = req.query.resourceId ? parseId(String(req.query.resourceId), 'resourceId') : null;
    const user = req.user!;

    if (resourceId !== null) {
      const [resource] = await db.select().from(resources).where(eq(resources.id, resourceId)).limit(1);
      if (!resource) throw notFound('Ressource nicht gefunden');
      if (user.role !== 'admin' && resource.userId !== user.id) {
        await ensureProjectAccess(resource.projectId, user, 'planner');
      }
    }

    const pkce = generatePkce();
    const nonce = randomBytes(16).toString('base64url');
    const state = await signState({
      userId: user.id,
      resourceId,
      projectId: req.query.projectId ? parseId(String(req.query.projectId), 'projectId') : null,
      verifier: pkce.verifier,
      nonce,
    });
    res.cookie(OUTLOOK_STATE_COOKIE, nonce, stateCookieOptions());
    res.json({ authorizeUrl: buildAuthorizeUrl(state, pkce.challenge) });
  });

  router.get('/projects/:projectId/outlook/connections', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);

    const rows = await db
      .select({
        connection: outlookConnections,
        resourceName: resources.name,
        resourceId: resources.id,
      })
      .from(outlookConnections)
      .leftJoin(resources, eq(resources.id, outlookConnections.resourceId))
      .where(eq(resources.projectId, projectId));

    res.json({
      configured: graphConfigured() && encryptionAvailable(),
      items: rows.map((row) => ({
        id: row.connection.id,
        resourceId: row.resourceId,
        resourceName: row.resourceName,
        mailbox: row.connection.mailbox,
        status: row.connection.status,
        syncEnabled: row.connection.syncEnabled,
        lastSyncAt: row.connection.lastSyncAt,
        lastError: row.connection.lastError,
      })),
    });
  });

  router.patch('/integrations/outlook/connections/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [connection] = await db
      .select()
      .from(outlookConnections)
      .where(eq(outlookConnections.id, id))
      .limit(1);
    if (!connection) throw notFound('Outlook-Verbindung nicht gefunden');
    await ensureConnectionAccess(connection, req.user!);
    const input = parse(outlookConnectionUpdateSchema, req.body);

    await db
      .update(outlookConnections)
      .set({ syncEnabled: input.syncEnabled, updatedAt: new Date() })
      .where(eq(outlookConnections.id, id));

    if (input.syncEnabled) {
      await enqueueJob('outlook.sync', { reason: 'connection-toggled' }, { runAt: new Date(Date.now() + 500) });
    }
    const [updated] = await db.select().from(outlookConnections).where(eq(outlookConnections.id, id)).limit(1);
    res.json({ connection: updated ? toConnectionDto(updated) : null });
  });

  router.delete('/integrations/outlook/connections/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [connection] = await db
      .select()
      .from(outlookConnections)
      .where(eq(outlookConnections.id, id))
      .limit(1);
    if (!connection) throw notFound('Outlook-Verbindung nicht gefunden');
    await ensureConnectionAccess(connection, req.user!);
    await deleteConnectionWithEvents(connection);
    res.status(204).end();
  });

  router.post('/projects/:projectId/outlook/sync', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!, 'planner');
    await enqueueJob('outlook.sync', { projectId, reason: 'manual' });
    res.status(202).json({ queued: true });
  });

  return router;
}
