import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import {
  assignments,
  outlookConnections,
  outlookEvents,
  projects,
  resources,
  tasks,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { decryptSecret, encryptSecret, encryptionAvailable } from './crypto.js';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getMe,
  refreshTokens,
  updateCalendarEvent,
  type GraphTokens,
} from './graph.js';

type ConnectionRow = typeof outlookConnections.$inferSelect;

export interface OutlookSyncResult {
  connections: number;
  created: number;
  updated: number;
  deleted: number;
  errors: number;
}

async function ensureAccessToken(connection: ConnectionRow): Promise<string> {
  if (!connection.accessTokenEnc || !connection.refreshTokenEnc) {
    throw new Error('Verbindung hat keine Tokens');
  }
  const accessToken = decryptSecret(connection.accessTokenEnc);
  const expiresAt = connection.expiresAt?.getTime() ?? 0;
  if (expiresAt > Date.now() + 60_000) return accessToken;

  const refreshed: GraphTokens = await refreshTokens(decryptSecret(connection.refreshTokenEnc));
  await db
    .update(outlookConnections)
    .set({
      accessTokenEnc: encryptSecret(refreshed.accessToken),
      refreshTokenEnc: refreshed.refreshToken
        ? encryptSecret(refreshed.refreshToken)
        : connection.refreshTokenEnc,
      expiresAt: refreshed.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(outlookConnections.id, connection.id));
  return refreshed.accessToken;
}

export async function storeConnectionTokens(
  connectionId: number,
  tokens: GraphTokens,
  mailbox: string,
): Promise<void> {
  await db
    .update(outlookConnections)
    .set({
      mailbox,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scope,
      status: 'connected',
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(outlookConnections.id, connectionId));
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

export function eventPayload(
  projectName: string,
  projectId: number,
  taskName: string,
  resourceName: string,
  start: Date,
  end: Date,
): Parameters<typeof createCalendarEvent>[1] {
  const link = `${config.APP_ORIGIN.replace(/\/$/, '')}/projects/${projectId}`;
  return {
    subject: `[${projectName}] ${taskName}`,
    bodyHtml: `<p>Ressource: <strong>${escapeHtml(resourceName)}</strong></p><p><a href="${escapeHtml(link)}">In ProjectPlaner öffnen</a></p>`,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    categories: ['ProjectPlaner'],
  };
}

async function resolveResourceIds(
  connection: ConnectionRow,
  projectId?: number,
): Promise<number[]> {
  if (connection.resourceId) {
    if (projectId === undefined) return [connection.resourceId];
    const [resource] = await db
      .select({ id: resources.id, projectId: resources.projectId })
      .from(resources)
      .where(eq(resources.id, connection.resourceId))
      .limit(1);
    return resource && resource.projectId === projectId ? [resource.id] : [];
  }
  if (connection.userId) {
    const conditions = [eq(resources.userId, connection.userId)];
    if (projectId !== undefined) conditions.push(eq(resources.projectId, projectId));
    const rows = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(...conditions));
    return rows.map((r) => r.id);
  }
  return [];
}

async function syncConnection(
  connection: ConnectionRow,
  projectId?: number,
): Promise<Omit<OutlookSyncResult, 'connections' | 'errors'>> {
  const result = { created: 0, updated: 0, deleted: 0 };

  const accessToken = await ensureAccessToken(connection);
  const targetResourceIds = await resolveResourceIds(connection, projectId);
  if (targetResourceIds.length === 0) {
    await db
      .update(outlookConnections)
      .set({ lastSyncAt: new Date(), status: 'connected', lastError: null })
      .where(eq(outlookConnections.id, connection.id));
    return result;
  }

  const desired = await db
    .select({
      assignmentId: assignments.id,
      resourceId: assignments.resourceId,
      resourceName: resources.name,
      plannedStart: assignments.plannedStart,
      plannedEnd: assignments.plannedEnd,
      taskId: tasks.id,
      taskName: tasks.name,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(assignments)
    .innerJoin(tasks, eq(tasks.id, assignments.taskId))
    .innerJoin(resources, eq(resources.id, assignments.resourceId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        inArray(assignments.resourceId, targetResourceIds),
        isNotNull(assignments.plannedStart),
        isNotNull(assignments.plannedEnd),
        ne(tasks.status, 'done'),
        eq(resources.isActive, true),
      ),
    );

  const existingRows = await db
    .select({ event: outlookEvents })
    .from(outlookEvents)
    .innerJoin(assignments, eq(assignments.id, outlookEvents.assignmentId))
    .where(
      and(
        eq(outlookEvents.connectionId, connection.id),
        inArray(assignments.resourceId, targetResourceIds),
      ),
    );
  const existing = existingRows.map((row) => row.event);
  const existingByAssignment = new Map(existing.map((e) => [e.assignmentId, e]));
  const desiredIds = new Set(desired.map((d) => d.assignmentId));

  for (const item of desired) {
    if (!item.plannedStart || !item.plannedEnd) continue;
    const payload = eventPayload(
      item.projectName,
      item.projectId,
      item.taskName,
      item.resourceName,
      item.plannedStart,
      item.plannedEnd,
    );
    const current = existingByAssignment.get(item.assignmentId);

    if (current && current.syncState !== 'deleted') {
      const updated = await updateCalendarEvent(accessToken, current.externalEventId, payload);
      if (updated === null) {
        // Event wurde in Outlook gelöscht → neu anlegen
        const created = await createCalendarEvent(accessToken, payload);
        await db
          .update(outlookEvents)
          .set({
            externalEventId: created.id,
            etag: created.changeKey ?? null,
            syncState: 'synced',
            lastSyncedAt: new Date(),
          })
          .where(eq(outlookEvents.id, current.id));
      } else {
        await db
          .update(outlookEvents)
          .set({
            etag: updated.changeKey ?? null,
            syncState: 'synced',
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(outlookEvents.id, current.id));
      }
      result.updated += 1;
    } else {
      const created = await createCalendarEvent(accessToken, payload);
      await db.insert(outlookEvents).values({
        assignmentId: item.assignmentId,
        connectionId: connection.id,
        externalEventId: created.id,
        etag: created.changeKey ?? null,
        syncState: 'synced',
        lastSyncedAt: new Date(),
      });
      result.created += 1;
    }
  }

  // Entfernte/abgeschlossene Zuteilungen → Termine löschen
  for (const event of existing) {
    if (desiredIds.has(event.assignmentId)) continue;
    try {
      await deleteCalendarEvent(accessToken, event.externalEventId);
    } catch (err) {
      logger.warn({ err, eventId: event.id }, 'Outlook-Termin konnte nicht gelöscht werden');
    }
    await db.delete(outlookEvents).where(eq(outlookEvents.id, event.id));
    result.deleted += 1;
  }

  await db
    .update(outlookConnections)
    .set({ lastSyncAt: new Date(), status: 'connected', lastError: null })
    .where(eq(outlookConnections.id, connection.id));

  return result;
}

/** Synchronisiert alle aktiven Outlook-Verbindungen (Outbound-Termine). */
export async function runOutlookSync(options?: { projectId?: number }): Promise<OutlookSyncResult> {
  const summary: OutlookSyncResult = { connections: 0, created: 0, updated: 0, deleted: 0, errors: 0 };
  if (!encryptionAvailable()) {
    logger.warn('Outlook-Sync übersprungen: APP_ENCRYPTION_KEY fehlt');
    return summary;
  }

  const connections = await db
    .select()
    .from(outlookConnections)
    .where(and(eq(outlookConnections.syncEnabled, true), ne(outlookConnections.status, 'revoked')));

  for (const connection of connections) {
    summary.connections += 1;
    try {
      const result = await syncConnection(connection, options?.projectId);
      summary.created += result.created;
      summary.updated += result.updated;
      summary.deleted += result.deleted;
    } catch (err) {
      summary.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, connectionId: connection.id }, 'Outlook-Sync für Verbindung fehlgeschlagen');
      await db
        .update(outlookConnections)
        .set({ status: 'error', lastError: message.slice(0, 2000), updatedAt: new Date() })
        .where(eq(outlookConnections.id, connection.id));
    }
  }

  return summary;
}

/** Entfernt alle ProjectPlaner-Termine einer Verbindung (best effort) und löscht sie. */
export async function deleteConnectionWithEvents(connection: ConnectionRow): Promise<void> {
  try {
    if (connection.accessTokenEnc && encryptionAvailable()) {
      const accessToken = await ensureAccessToken(connection);
      const events = await db
        .select()
        .from(outlookEvents)
        .where(eq(outlookEvents.connectionId, connection.id));
      for (const event of events) {
        try {
          await deleteCalendarEvent(accessToken, event.externalEventId);
        } catch {
          /* best effort */
        }
      }
    }
  } catch (err) {
    logger.warn({ err, connectionId: connection.id }, 'Termine beim Trennen nicht vollständig gelöscht');
  }
  await db.delete(outlookConnections).where(eq(outlookConnections.id, connection.id));
}

export async function mailboxOf(token: string): Promise<string> {
  const me = await getMe(token);
  return me.mail ?? me.userPrincipalName;
}
