import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { apiKeyCreateSchema, apiKeyUpdateSchema } from '@projectplaner/shared';
import { db } from '../db/client.js';
import { projectApiKeys } from '../db/schema.js';
import { notFound, unprocessable } from '../errors.js';
import { requireAuth } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { parseOpenSshPublicKey, SshKeyParseError } from '../http/sshAuth.js';
import { ensureProjectAccess } from '../services/access.js';
import { writeAudit } from '../services/audit.js';

type ApiKeyRow = typeof projectApiKeys.$inferSelect;

/**
 * Admin-DTO: enthält bewusst keine privaten Daten – ein OpenSSH-Public-Key ist
 * öffentlich, sodass nur abgeleitete Metadaten (Fingerprint, Typ) nötig sind.
 */
function toApiKeyDto(key: ApiKeyRow) {
  return {
    id: key.id,
    projectId: key.projectId,
    name: key.name,
    keyType: key.keyType,
    fingerprint: key.fingerprint,
    expiresAt: key.expiresAt,
    isActive: key.isActive,
    lastUsedAt: key.lastUsedAt,
    createdBy: key.createdBy,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

async function loadKey(id: number): Promise<ApiKeyRow> {
  const [key] = await db.select().from(projectApiKeys).where(eq(projectApiKeys.id, id)).limit(1);
  if (!key) throw notFound('API-Schlüssel nicht gefunden');
  return key;
}

export function apiKeyRoutes(): Router {
  const router = Router();
  // Gate auf die eigenen Präfixe beschränken: Der Router wird auf '/' gemountet,
  // ungescopte Middleware würde sonst öffentliche Routen (z. B. den
  // Outlook-OAuth-Callback) abfangen.
  router.use(['/projects/:projectId/api-keys', '/api-keys'], requireAuth);

  router.get('/projects/:projectId/api-keys', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!, 'planner');
    const rows = await db
      .select()
      .from(projectApiKeys)
      .where(eq(projectApiKeys.projectId, projectId))
      .orderBy(asc(projectApiKeys.name), asc(projectApiKeys.id));
    res.json({ items: rows.map(toApiKeyDto) });
  });

  router.post('/projects/:projectId/api-keys', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!, 'planner');
    const input = parse(apiKeyCreateSchema, req.body);

    let publicKey;
    try {
      publicKey = parseOpenSshPublicKey(input.publicKey);
    } catch (err) {
      const message =
        err instanceof SshKeyParseError ? err.message : 'Public Key konnte nicht gelesen werden';
      throw unprocessable([{ path: 'publicKey', message }]);
    }

    const [created] = await db
      .insert(projectApiKeys)
      .values({
        projectId,
        name: input.name,
        publicKey: input.publicKey.trim(),
        keyType: publicKey.keyType,
        fingerprint: publicKey.fingerprint,
        expiresAt: input.expiresAt ?? null,
        createdBy: req.user!.id,
      })
      .$returningId();

    await writeAudit({
      userId: req.user!.id,
      entityType: 'api-key',
      entityId: created!.id,
      action: 'create',
      diff: { name: input.name, keyType: publicKey.keyType, fingerprint: publicKey.fingerprint },
    });

    const row = await loadKey(created!.id);
    res.status(201).json({ apiKey: toApiKeyDto(row) });
  });

  router.patch('/api-keys/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await loadKey(id);
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');
    const input = parse(apiKeyUpdateSchema, req.body);

    const updates: Partial<typeof projectApiKeys.$inferInsert> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.expiresAt !== undefined) updates.expiresAt = input.expiresAt ?? null;
    if (input.isActive !== undefined) updates.isActive = input.isActive;

    await db.update(projectApiKeys).set(updates).where(eq(projectApiKeys.id, id));
    await writeAudit({
      userId: req.user!.id,
      entityType: 'api-key',
      entityId: id,
      action: 'update',
      diff: input as Record<string, unknown>,
    });

    const row = await loadKey(id);
    res.json({ apiKey: toApiKeyDto(row) });
  });

  router.delete('/api-keys/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await loadKey(id);
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');
    await db.delete(projectApiKeys).where(eq(projectApiKeys.id, id));
    await writeAudit({
      userId: req.user!.id,
      entityType: 'api-key',
      entityId: id,
      action: 'delete',
      diff: { name: existing.name, fingerprint: existing.fingerprint },
    });
    res.status(204).end();
  });

  return router;
}
