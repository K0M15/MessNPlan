import { Router } from 'express';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  absenceCreateSchema,
  resourceCreateSchema,
  resourceUpdateSchema,
  REALTIME_EVENTS,
} from '@projectplaner/shared';
import { db } from '../db/client.js';
import { absences, assignments, resources, tasks, users } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { requireAuth } from '../http/auth.js';
import { parse, parseId, parseIfMatch } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureProjectAccess } from '../services/access.js';
import { writeAudit } from '../services/audit.js';

export function resourceRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/projects/:projectId/resources', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);

    const resourceRows = await db
      .select()
      .from(resources)
      .where(eq(resources.projectId, projectId))
      .orderBy(resources.name);

    const ids = resourceRows.map((r) => r.id);
    const counts = new Map<number, number>();
    if (ids.length > 0) {
      const countRows = await db
        .select({ resourceId: assignments.resourceId, count: sql<number>`count(*)` })
        .from(assignments)
        .innerJoin(tasks, eq(tasks.id, assignments.taskId))
        .where(and(inArray(assignments.resourceId, ids), ne(tasks.status, 'done')))
        .groupBy(assignments.resourceId);
      for (const row of countRows) counts.set(row.resourceId, Number(row.count));
    }

    res.json({
      items: resourceRows.map((resource) => ({
        ...resource,
        openAssignmentCount: counts.get(resource.id) ?? 0,
      })),
    });
  });

  router.post('/projects/:projectId/resources', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!, 'planner');
    const input = parse(resourceCreateSchema, req.body);

    if (input.userId) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
      if (!user) throw notFound('Verknüpfter Benutzer nicht gefunden');
    }

    const [created] = await db
      .insert(resources)
      .values({
        projectId,
        userId: input.userId ?? null,
        name: input.name,
        type: input.type,
        email: input.email ?? null,
        capacityMinutesPerDay: input.capacityMinutesPerDay,
        workingHours: input.workingHours ?? null,
        color: input.color ?? null,
        isActive: input.isActive,
      })
      .$returningId();

    await writeAudit({
      userId: req.user!.id,
      entityType: 'resource',
      entityId: created!.id,
      action: 'create',
    });
    broadcastToProject(projectId, REALTIME_EVENTS.PROJECT_CHANGED, { projectId });

    const [resource] = await db.select().from(resources).where(eq(resources.id, created!.id)).limit(1);
    res.status(201).json({ resource });
  });

  router.patch('/resources/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
    if (!existing) throw notFound('Ressource nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');
    const input = parse(resourceUpdateSchema, req.body);

    if (input.userId) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
      if (!user) throw notFound('Verknüpfter Benutzer nicht gefunden');
    }

    const updates: Partial<typeof resources.$inferInsert> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.type !== undefined) updates.type = input.type;
    if (input.userId !== undefined) updates.userId = input.userId ?? null;
    if (input.email !== undefined) updates.email = input.email ?? null;
    if (input.capacityMinutesPerDay !== undefined)
      updates.capacityMinutesPerDay = input.capacityMinutesPerDay;
    if (input.workingHours !== undefined) updates.workingHours = input.workingHours ?? null;
    if (input.color !== undefined) updates.color = input.color ?? null;
    if (input.isActive !== undefined) updates.isActive = input.isActive;

    const expectedVersion = parseIfMatch(req);
    const where = expectedVersion
      ? and(eq(resources.id, id), eq(resources.version, expectedVersion))
      : eq(resources.id, id);
    const [result] = await db
      .update(resources)
      .set({ ...updates, version: sql`version + 1` })
      .where(where);
    if (expectedVersion && result.affectedRows === 0) {
      throw conflict('Ressource wurde zwischenzeitlich geändert. Bitte neu laden.');
    }

    const [resource] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
    broadcastToProject(existing.projectId, REALTIME_EVENTS.PROJECT_CHANGED, {
      projectId: existing.projectId,
    });
    res.json({ resource });
  });

  router.delete('/resources/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
    if (!existing) throw notFound('Ressource nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');

    await db.delete(resources).where(eq(resources.id, id));
    await writeAudit({
      userId: req.user!.id,
      entityType: 'resource',
      entityId: id,
      action: 'delete',
    });
    broadcastToProject(existing.projectId, REALTIME_EVENTS.PROJECT_CHANGED, {
      projectId: existing.projectId,
    });
    res.status(204).end();
  });

  // ---- Abwesenheiten -------------------------------------------------------

  /** `Date` (UTC-Mitternacht aus Zod-Coerce) → `YYYY-MM-DD` für die date-Spalte. */
  const toDateString = (value: Date): string => value.toISOString().slice(0, 10);

  router.get('/resources/:id/absences', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
    if (!existing) throw notFound('Ressource nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!);

    const items = await db
      .select()
      .from(absences)
      .where(eq(absences.resourceId, id))
      .orderBy(absences.startDate);
    res.json({ items });
  });

  router.post('/resources/:id/absences', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
    if (!existing) throw notFound('Ressource nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!, 'planner');
    const input = parse(absenceCreateSchema, req.body);

    const [created] = await db
      .insert(absences)
      .values({
        resourceId: id,
        startDate: toDateString(input.startDate),
        endDate: toDateString(input.endDate),
        type: input.type,
        name: input.name?.trim() || null,
        createdBy: req.user!.id,
      })
      .$returningId();

    await writeAudit({
      userId: req.user!.id,
      entityType: 'absence',
      entityId: created!.id,
      action: 'create',
    });
    broadcastToProject(existing.projectId, REALTIME_EVENTS.PROJECT_CHANGED, {
      projectId: existing.projectId,
    });

    const [absence] = await db.select().from(absences).where(eq(absences.id, created!.id)).limit(1);
    res.status(201).json({ absence });
  });

  router.delete('/absences/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(absences).where(eq(absences.id, id)).limit(1);
    if (!existing) throw notFound('Abwesenheit nicht gefunden');
    const [resource] = await db
      .select({ projectId: resources.projectId })
      .from(resources)
      .where(eq(resources.id, existing.resourceId))
      .limit(1);
    if (!resource) throw notFound('Ressource nicht gefunden');
    await ensureProjectAccess(resource.projectId, req.user!, 'planner');

    await db.delete(absences).where(eq(absences.id, id));
    await writeAudit({
      userId: req.user!.id,
      entityType: 'absence',
      entityId: id,
      action: 'delete',
    });
    broadcastToProject(resource.projectId, REALTIME_EVENTS.PROJECT_CHANGED, {
      projectId: resource.projectId,
    });
    res.status(204).end();
  });

  // Übersicht aller Zuteilungen einer Ressource (für Auslastungsansichten)
  router.get('/resources/:id/assignments', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
    if (!existing) throw notFound('Ressource nicht gefunden');
    await ensureProjectAccess(existing.projectId, req.user!);

    const rows = await db
      .select({
        id: assignments.id,
        taskId: assignments.taskId,
        allocationPercent: assignments.allocationPercent,
        plannedStart: assignments.plannedStart,
        plannedEnd: assignments.plannedEnd,
      })
      .from(assignments)
      .where(eq(assignments.resourceId, id));

    res.json({ items: rows });
  });

  return router;
}
