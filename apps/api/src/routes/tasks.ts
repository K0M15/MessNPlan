import { Router } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  taskCreateSchema,
  taskMoveSchema,
  taskUpdateSchema,
  type ConstraintType,
} from '@projectplaner/shared';
import { db } from '../db/client.js';
import { assignments, resources, tags, taskTags, tasks } from '../db/schema.js';
import { badRequest, conflict } from '../errors.js';
import { requireAuth } from '../http/auth.js';
import { parse, parseId, parseIfMatch } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureProjectAccess, ensureProjectWrite, ensureTaskAccess } from '../services/access.js';
import { writeAudit } from '../services/audit.js';
import { enqueueJob } from '../services/outbox.js';

interface TagDto {
  id: number;
  name: string;
  color: string;
}

interface AssignmentDto {
  id: number;
  resourceId: number;
  resourceName: string;
  resourceType: 'person' | 'machine';
  allocationPercent: number;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  version: number;
}

type TaskRow = typeof tasks.$inferSelect;

export function validateConstraint(type: ConstraintType, date: Date | null | undefined): Date | null {
  if (type !== 'asap' && !date) {
    throw badRequest('Für diesen Constraint-Typ ist ein Datum erforderlich');
  }
  return type === 'asap' ? null : (date ?? null);
}

async function loadTagsByTask(projectId: number): Promise<Map<number, TagDto[]>> {
  const rows = await db
    .select({
      taskId: taskTags.taskId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(eq(tags.projectId, projectId));

  const map = new Map<number, TagDto[]>();
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.taskId, list);
  }
  return map;
}

async function loadAssignmentsByTask(projectId: number): Promise<Map<number, AssignmentDto[]>> {
  const rows = await db
    .select({
      taskId: assignments.taskId,
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
    .where(eq(resources.projectId, projectId));

  const map = new Map<number, AssignmentDto[]>();
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push({
      id: row.id,
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      resourceType: row.resourceType,
      allocationPercent: row.allocationPercent,
      plannedStart: row.plannedStart,
      plannedEnd: row.plannedEnd,
      version: row.version,
    });
    map.set(row.taskId, list);
  }
  return map;
}

function buildTree(rows: TaskRow[]): Array<TaskRow & { children: unknown[] }> {
  const nodes = new Map<number, TaskRow & { children: unknown[] }>();
  for (const row of rows) nodes.set(row.id, { ...row, children: [] });
  const roots: Array<TaskRow & { children: unknown[] }> = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.parentId && nodes.has(row.parentId)) {
      nodes.get(row.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function taskRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  // ---- Liste & Anlage im Projekt ---------------------------------------

  router.get('/projects/:projectId/tasks', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);
    const tree = req.query.tree === '1' || req.query.tree === 'true';

    const rows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id));

    const [tagsByTask, assignmentsByTask] = await Promise.all([
      loadTagsByTask(projectId),
      loadAssignmentsByTask(projectId),
    ]);

    const decorate = (task: TaskRow) => ({
      ...task,
      tags: tagsByTask.get(task.id) ?? [],
      assignments: assignmentsByTask.get(task.id) ?? [],
    });

    if (tree) {
      const roots = buildTree(rows);
      const decorateTree = (nodes: Array<TaskRow & { children: unknown[] }>): unknown[] =>
        nodes.map((node) => ({
          ...decorate(node),
          children: decorateTree(node.children as Array<TaskRow & { children: unknown[] }>),
        }));
      res.json({ items: decorateTree(roots) });
      return;
    }

    res.json({ items: rows.map(decorate) });
  });

  router.post('/projects/:projectId/tasks', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectWrite(projectId, req.user!);
    const input = parse(taskCreateSchema, req.body);

    const parentId: number | null = input.parentId ?? null;
    if (parentId !== null) {
      const [parent] = await db.select().from(tasks).where(eq(tasks.id, parentId)).limit(1);
      if (!parent || parent.projectId !== projectId) {
        throw badRequest('Elternaufgabe liegt nicht in diesem Projekt');
      }
    }

    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [maxRow] = await db
        .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, projectId),
            parentId === null ? sql`${tasks.parentId} is null` : eq(tasks.parentId, parentId),
          ),
        );
      sortOrder = (maxRow?.max ?? 0) + 1;
    }

    const constraintDate = validateConstraint(input.constraintType, input.constraintDate ?? null);

    const [created] = await db
      .insert(tasks)
      .values({
        projectId,
        parentId,
        name: input.name,
        description: input.description ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        status: input.status,
        priority: input.priority,
        constraintType: input.constraintType,
        constraintDate,
        isMilestone: input.isMilestone,
        sortOrder,
        createdBy: req.user!.id,
      })
      .$returningId();

    await writeAudit({
      userId: req.user!.id,
      entityType: 'task',
      entityId: created!.id,
      action: 'create',
    });
    await enqueueJob('schedule.compute', { projectId, reason: 'task.created' });
    broadcastToProject(projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: created!.id,
      projectId,
      action: 'created',
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, created!.id)).limit(1);
    res.status(201).json({ task: { ...task!, tags: [], assignments: [] } });
  });

  // ---- Einzelne Aufgabe -------------------------------------------------

  router.get('/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { task, project } = await ensureTaskAccess(id, req.user!);

    const [tagRows, assignmentRows] = await Promise.all([
      db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(taskTags)
        .innerJoin(tags, eq(tags.id, taskTags.tagId))
        .where(eq(taskTags.taskId, id)),
      db
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
        .where(eq(assignments.taskId, id)),
    ]);

    res.json({
      task: { ...task, tags: tagRows, assignments: assignmentRows },
      project: { id: project.id, name: project.name, myRole: null },
    });
  });

  router.patch('/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'member');
    const input = parse(taskUpdateSchema, req.body);

    const constraintType = input.constraintType ?? task.constraintType;
    const constraintInput =
      input.constraintDate !== undefined ? input.constraintDate : task.constraintDate;
    const constraintDate = validateConstraint(constraintType, constraintInput ?? null);

    const updates: Partial<typeof tasks.$inferInsert> = {
      constraintType,
      constraintDate,
    };
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description ?? null;
    if (input.estimatedMinutes !== undefined)
      updates.estimatedMinutes = input.estimatedMinutes ?? null;
    if (input.status !== undefined) updates.status = input.status;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.isMilestone !== undefined) updates.isMilestone = input.isMilestone;
    if (input.progress !== undefined) updates.progress = input.progress;
    if (input.actualStart !== undefined) updates.actualStart = input.actualStart ?? null;
    if (input.actualEnd !== undefined) updates.actualEnd = input.actualEnd ?? null;

    const expectedVersion = parseIfMatch(req);
    const where = expectedVersion
      ? and(eq(tasks.id, id), eq(tasks.version, expectedVersion))
      : eq(tasks.id, id);

    const [result] = await db
      .update(tasks)
      .set({ ...updates, version: sql`version + 1` })
      .where(where);

    if (expectedVersion && result.affectedRows === 0) {
      throw conflict('Aufgabe wurde zwischenzeitlich geändert. Bitte neu laden.');
    }

    await writeAudit({
      userId: req.user!.id,
      entityType: 'task',
      entityId: id,
      action: 'update',
      diff: input as Record<string, unknown>,
    });
    await enqueueJob('schedule.compute', { projectId: task.projectId, reason: 'task.updated' });
    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: id,
      projectId: task.projectId,
      action: 'updated',
    });

    const [updated] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    res.json({ task: updated });
  });

  router.delete('/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'planner');
    await db.delete(tasks).where(eq(tasks.id, id));
    await writeAudit({
      userId: req.user!.id,
      entityType: 'task',
      entityId: id,
      action: 'delete',
    });
    await enqueueJob('schedule.compute', { projectId: task.projectId, reason: 'task.deleted' });
    broadcastToProject(task.projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: id,
      projectId: task.projectId,
      action: 'deleted',
    });
    res.status(204).end();
  });

  router.post('/tasks/:id/move', async (req, res) => {
    const id = parseId(req.params.id);
    const { task } = await ensureTaskAccess(id, req.user!, 'member');
    const input = parse(taskMoveSchema, req.body);
    const projectId = task.projectId;

    const newParentId = input.parentId ?? null;

    if (newParentId !== null) {
      if (newParentId === id) throw badRequest('Aufgabe kann nicht ihr eigener Elternteil sein');

      const projectTasks = await db
        .select({ id: tasks.id, parentId: tasks.parentId })
        .from(tasks)
        .where(eq(tasks.projectId, projectId));
      const byId = new Map(projectTasks.map((t) => [t.id, t]));

      const parent = byId.get(newParentId);
      if (!parent) throw badRequest('Elternaufgabe liegt nicht in diesem Projekt');

      // Aufstieg prüfen: neuer Elternteil darf nicht Nachfahre der Aufgabe sein.
      let cursor: number | null = newParentId;
      const seen = new Set<number>();
      while (cursor !== null && !seen.has(cursor)) {
        if (cursor === id) throw badRequest('Aufgabe kann nicht unter ihre eigene Teilaufgabe verschoben werden');
        seen.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
    }

    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [maxRow] = await db
        .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, projectId),
            newParentId === null ? sql`${tasks.parentId} is null` : eq(tasks.parentId, newParentId),
          ),
        );
      sortOrder = (maxRow?.max ?? 0) + 1;
    }

    const expectedVersion = parseIfMatch(req);
    const where = expectedVersion
      ? and(eq(tasks.id, id), eq(tasks.version, expectedVersion))
      : eq(tasks.id, id);
    const [result] = await db
      .update(tasks)
      .set({ parentId: newParentId, sortOrder, version: sql`version + 1` })
      .where(where);
    if (expectedVersion && result.affectedRows === 0) {
      throw conflict('Aufgabe wurde zwischenzeitlich geändert. Bitte neu laden.');
    }

    await writeAudit({
      userId: req.user!.id,
      entityType: 'task',
      entityId: id,
      action: 'move',
      diff: { parentId: newParentId, sortOrder },
    });
    await enqueueJob('schedule.compute', { projectId, reason: 'task.moved' });
    broadcastToProject(projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: id,
      projectId,
      action: 'moved',
    });
    const [updated] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    res.json({ task: updated });
  });

  return router;
}

export { loadTagsByTask, loadAssignmentsByTask };
