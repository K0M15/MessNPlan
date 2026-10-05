import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import {
  dependencyCreateSchema,
  dependencyUpdateSchema,
  REALTIME_EVENTS,
} from '@projectplaner/shared';
import { db } from '../db/client.js';
import { taskDependencies, tasks } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAuth } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureTaskAccess } from '../services/access.js';
import { writeAudit } from '../services/audit.js';
import { loadProjectEdges, wouldCreateCycle } from '../services/dependencyGraph.js';
import { enqueueJob } from '../services/outbox.js';

export async function dependencyDto(ids: number[]) {
  if (ids.length === 0) return [] as Array<Record<string, unknown>>;
  const rows = await db
    .select({ id: taskDependencies.id, predecessorId: taskDependencies.predecessorId, successorId: taskDependencies.successorId, type: taskDependencies.type, lagMinutes: taskDependencies.lagMinutes })
    .from(taskDependencies)
    .where(inArray(taskDependencies.id, ids));

  const taskIds = [...new Set(rows.flatMap((r) => [r.predecessorId, r.successorId]))];
  const taskRows = taskIds.length
    ? await db.select({ id: tasks.id, name: tasks.name }).from(tasks).where(inArray(tasks.id, taskIds))
    : [];
  const names = new Map(taskRows.map((t) => [t.id, t.name]));

  return rows.map((r) => ({
    ...r,
    predecessorName: names.get(r.predecessorId) ?? '',
    successorName: names.get(r.successorId) ?? '',
  }));
}

export function dependencyRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/tasks/:id/dependencies', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureTaskAccess(id, req.user!);

    // Kanten mit predecessorId = id sind Nachfolger, Kanten mit successorId = id sind Vorgänger.
    const outgoing = await db
      .select({ id: taskDependencies.id })
      .from(taskDependencies)
      .where(and(eq(taskDependencies.predecessorId, id)));
    const incoming = await db
      .select({ id: taskDependencies.id })
      .from(taskDependencies)
      .where(eq(taskDependencies.successorId, id));

    const [predecessors, successors] = await Promise.all([
      dependencyDto(incoming.map((r) => r.id)),
      dependencyDto(outgoing.map((r) => r.id)),
    ]);

    res.json({ predecessors, successors });
  });

  router.post('/tasks/:id/dependencies', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'member');
    const input = parse(dependencyCreateSchema, req.body);

    if (input.predecessorId !== id && input.successorId !== id) {
      throw badRequest('Die Aufgabe muss Vorgänger oder Nachfolger der Abhängigkeit sein');
    }

    const endpointIds = [...new Set([input.predecessorId, input.successorId])];
    const rows = await db.select().from(tasks).where(inArray(tasks.id, endpointIds));
    if (rows.length !== endpointIds.length) throw notFound('Aufgabe nicht gefunden');
    if (rows.some((t) => t.projectId !== task.projectId)) {
      throw badRequest('Abhängigkeiten sind nur innerhalb eines Projekts erlaubt');
    }

    // Oberaufgabe als Vorgänger ihres eigenen Nachfahren ergäbe einen Hierarchie-Zyklus.
    const projectTasks = await db
      .select({ id: tasks.id, parentId: tasks.parentId })
      .from(tasks)
      .where(eq(tasks.projectId, task.projectId));
    const byId = new Map(projectTasks.map((t) => [t.id, t]));
    const isDescendant = (ancestorId: number, nodeId: number): boolean => {
      let cursor: number | null = nodeId;
      const seen = new Set<number>();
      while (cursor !== null && !seen.has(cursor)) {
        if (cursor === ancestorId) return true;
        seen.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      return false;
    };
    if (isDescendant(input.predecessorId, input.successorId)) {
      throw badRequest('Eine Oberaufgabe kann nicht Vorgänger einer ihrer Teilaufgaben sein');
    }

    const edges = await loadProjectEdges(task.projectId);
    if (wouldCreateCycle(edges, input.predecessorId, input.successorId)) {
      throw badRequest('Diese Abhängigkeit würde einen Zyklus erzeugen');
    }

    const existing = edges.find(
      (e) => e.predecessorId === input.predecessorId && e.successorId === input.successorId,
    );
    if (existing) throw conflict('Diese Abhängigkeit existiert bereits');

    const [created] = await db
      .insert(taskDependencies)
      .values({
        projectId: task.projectId,
        predecessorId: input.predecessorId,
        successorId: input.successorId,
        type: input.type,
        lagMinutes: input.lagMinutes,
      })
      .$returningId();

    await writeAudit({
      userId: req.user!.id,
      entityType: 'dependency',
      entityId: created!.id,
      action: 'create',
    });
    await enqueueJob('schedule.compute', { projectId: task.projectId, reason: 'dependency.created' });
    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: id,
      projectId: task.projectId,
      action: 'dependency-changed',
    });

    const [dto] = await dependencyDto([created!.id]);
    res.status(201).json({ dependency: dto });
  });

  router.patch('/dependencies/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.id, id))
      .limit(1);
    if (!existing) throw notFound('Abhängigkeit nicht gefunden');
    await ensureTaskAccess(existing.predecessorId, req.user!, 'member');

    const input = parse(dependencyUpdateSchema, req.body);
    await db
      .update(taskDependencies)
      .set({
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.lagMinutes !== undefined ? { lagMinutes: input.lagMinutes } : {}),
      })
      .where(eq(taskDependencies.id, id));

    await enqueueJob('schedule.compute', { projectId: existing.projectId, reason: 'dependency.updated' });
    broadcastToProject(existing.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: existing.successorId,
      projectId: existing.projectId,
      action: 'dependency-changed',
    });

    const [dto] = await dependencyDto([id]);
    res.json({ dependency: dto });
  });

  router.delete('/dependencies/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [existing] = await db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.id, id))
      .limit(1);
    if (!existing) throw notFound('Abhängigkeit nicht gefunden');
    await ensureTaskAccess(existing.predecessorId, req.user!, 'member');

    await db.delete(taskDependencies).where(eq(taskDependencies.id, id));
    await enqueueJob('schedule.compute', { projectId: existing.projectId, reason: 'dependency.deleted' });
    broadcastToProject(existing.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: existing.successorId,
      projectId: existing.projectId,
      action: 'dependency-changed',
    });
    res.status(204).end();
  });

  return router;
}
