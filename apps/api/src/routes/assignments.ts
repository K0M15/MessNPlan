import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import {
  assignmentCreateSchema,
  assignmentUpdateSchema,
  REALTIME_EVENTS,
} from '@projectplaner/shared';
import { db } from '../db/client.js';
import { assignments, resources } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { requireAuth } from '../http/auth.js';
import { parse, parseId, parseIfMatch } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureTaskAccess } from '../services/access.js';
import { writeAudit } from '../services/audit.js';
import { enqueueJob } from '../services/outbox.js';

export function assignmentRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/tasks/:id/assignments', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureTaskAccess(id, req.user!);
    const rows = await db
      .select({
        id: assignments.id,
        resourceId: resources.id,
        resourceName: resources.name,
        resourceType: resources.type,
        allocationPercent: assignments.allocationPercent,
        plannedStart: assignments.plannedStart,
        plannedEnd: assignments.plannedEnd,
        version: assignments.version,
      })
      .from(assignments)
      .innerJoin(resources, eq(resources.id, assignments.resourceId))
      .where(eq(assignments.taskId, id));
    res.json({ items: rows });
  });

  router.post('/tasks/:id/assignments', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'member');
    const input = parse(assignmentCreateSchema, req.body);

    const [resource] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, input.resourceId))
      .limit(1);
    if (!resource || resource.projectId !== task.projectId) {
      throw notFound('Ressource liegt nicht in diesem Projekt');
    }

    const [existing] = await db
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.taskId, id), eq(assignments.resourceId, input.resourceId)))
      .limit(1);
    if (existing) throw conflict('Diese Ressource ist der Aufgabe bereits zugeordnet');

    const [created] = await db
      .insert(assignments)
      .values({
        taskId: id,
        resourceId: input.resourceId,
        allocationPercent: input.allocationPercent,
      })
      .$returningId();

    await writeAudit({
      userId: req.user!.id,
      entityType: 'assignment',
      entityId: created!.id,
      action: 'create',
    });
    await enqueueJob('schedule.compute', { projectId: task.projectId, reason: 'assignment.created' });
    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: id,
      projectId: task.projectId,
      action: 'assignment-changed',
    });

    const [row] = await db
      .select({
        id: assignments.id,
        resourceId: resources.id,
        resourceName: resources.name,
        resourceType: resources.type,
        allocationPercent: assignments.allocationPercent,
        plannedStart: assignments.plannedStart,
        plannedEnd: assignments.plannedEnd,
        version: assignments.version,
      })
      .from(assignments)
      .innerJoin(resources, eq(resources.id, assignments.resourceId))
      .where(eq(assignments.id, created!.id))
      .limit(1);

    res.status(201).json({ assignment: row });
  });

  router.patch('/assignments/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(assignments).where(eq(assignments.id, id)).limit(1);
    if (!existing) throw notFound('Zuteilung nicht gefunden');
    const { task } = await ensureTaskAccess(existing.taskId, req.user!, 'member');
    const input = parse(assignmentUpdateSchema, req.body);

    const expectedVersion = parseIfMatch(req);
    const where = expectedVersion
      ? and(eq(assignments.id, id), eq(assignments.version, expectedVersion))
      : eq(assignments.id, id);
    const [result] = await db
      .update(assignments)
      .set({ allocationPercent: input.allocationPercent, version: sql`version + 1` })
      .where(where);
    if (expectedVersion && result.affectedRows === 0) {
      throw conflict('Zuteilung wurde zwischenzeitlich geändert. Bitte neu laden.');
    }

    await enqueueJob('schedule.compute', { projectId: task.projectId, reason: 'assignment.updated' });
    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: existing.taskId,
      projectId: task.projectId,
      action: 'assignment-changed',
    });

    const [row] = await db.select().from(assignments).where(eq(assignments.id, id)).limit(1);
    res.json({ assignment: row });
  });

  router.delete('/assignments/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db.select().from(assignments).where(eq(assignments.id, id)).limit(1);
    if (!existing) throw notFound('Zuteilung nicht gefunden');
    const { task } = await ensureTaskAccess(existing.taskId, req.user!, 'member');

    await db.delete(assignments).where(eq(assignments.id, id));
    await enqueueJob('schedule.compute', { projectId: task.projectId, reason: 'assignment.deleted' });
    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: existing.taskId,
      projectId: task.projectId,
      action: 'assignment-changed',
    });
    res.status(204).end();
  });

  return router;
}
