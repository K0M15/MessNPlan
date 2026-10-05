import { Router, type Request } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  assignmentCreateSchema,
  dependencyCreateSchema,
  REALTIME_EVENTS,
  taskCreateSchema,
} from '@projectplaner/shared';
import { db } from '../db/client.js';
import { assignments, resources, taskDependencies, tasks } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { apiKeyRateLimit, sshAuth } from '../http/sshAuth.js';
import { parse, parseId } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { dependencyDto } from './dependencies.js';
import { validateConstraint } from './tasks.js';
import { writeAudit } from '../services/audit.js';
import { loadProjectEdges, wouldCreateCycle } from '../services/dependencyGraph.js';
import { enqueueJob } from '../services/outbox.js';

/**
 * Externe, SSH-key-authentifizierte API. Jeder Schlüssel gehört genau zu einem
 * Projekt; Zugriffe auf andere Projekte werden mit 403 abgelehnt. Es gibt
 * keinen interaktiven Nutzer: Audits laufen mit `userId: null` und
 * `entityType`-Suffix `:external`.
 */
export function externalRoutes(): Router {
  const router = Router();
  router.use(sshAuth, apiKeyRateLimit);

  /** Stellt sicher, dass der Schlüssel zum Projekt der URL gehört. */
  function ensureKeyProject(req: Request, projectId: number): void {
    if (req.apiKey!.projectId !== projectId) {
      throw forbidden('API-Schlüssel gehört zu einem anderen Projekt');
    }
  }

  // ---- Aufgabe anlegen (optional als Unteraufgabe) -----------------------

  router.post('/projects/:projectId/tasks', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    ensureKeyProject(req, projectId);
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
        createdBy: null,
      })
      .$returningId();

    await writeAudit({
      userId: null,
      entityType: 'task:external',
      entityId: created!.id,
      action: 'create',
      diff: { apiKeyId: req.apiKey!.id, apiKeyName: req.apiKey!.name, name: input.name, parentId },
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

  // ---- Abhängigkeit anlegen ----------------------------------------------

  router.post('/projects/:projectId/dependencies', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    ensureKeyProject(req, projectId);
    const input = parse(dependencyCreateSchema, req.body);

    const endpointIds = [...new Set([input.predecessorId, input.successorId])];
    const rows = await db.select().from(tasks).where(inArray(tasks.id, endpointIds));
    if (rows.length !== endpointIds.length) throw notFound('Aufgabe nicht gefunden');
    if (rows.some((t) => t.projectId !== projectId)) {
      throw badRequest('Abhängigkeiten sind nur innerhalb eines Projekts erlaubt');
    }

    // Oberaufgabe als Vorgänger ihres eigenen Nachfahren ergäbe einen Hierarchie-Zyklus.
    const projectTasks = await db
      .select({ id: tasks.id, parentId: tasks.parentId })
      .from(tasks)
      .where(eq(tasks.projectId, projectId));
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

    const edges = await loadProjectEdges(projectId);
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
        projectId,
        predecessorId: input.predecessorId,
        successorId: input.successorId,
        type: input.type,
        lagMinutes: input.lagMinutes,
      })
      .$returningId();

    await writeAudit({
      userId: null,
      entityType: 'dependency:external',
      entityId: created!.id,
      action: 'create',
      diff: {
        apiKeyId: req.apiKey!.id,
        predecessorId: input.predecessorId,
        successorId: input.successorId,
        type: input.type,
        lagMinutes: input.lagMinutes,
      },
    });
    await enqueueJob('schedule.compute', { projectId, reason: 'dependency.created' });
    broadcastToProject(projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId: input.successorId,
      projectId,
      action: 'dependency-changed',
    });

    const dto = await dependencyDto([created!.id]);
    res.status(201).json({ dependency: dto[0] });
  });

  // ---- Ressource zuteilen ------------------------------------------------

  router.post('/projects/:projectId/tasks/:taskId/assignments', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    const taskId = parseId(req.params.taskId, 'taskId');
    ensureKeyProject(req, projectId);
    const input = parse(assignmentCreateSchema, req.body);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task || task.projectId !== projectId) {
      throw notFound('Aufgabe nicht gefunden');
    }

    const [resource] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, input.resourceId))
      .limit(1);
    if (!resource || resource.projectId !== projectId) {
      throw notFound('Ressource liegt nicht in diesem Projekt');
    }

    const [existing] = await db
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.taskId, taskId), eq(assignments.resourceId, input.resourceId)))
      .limit(1);
    if (existing) throw conflict('Diese Ressource ist der Aufgabe bereits zugeordnet');

    const [created] = await db
      .insert(assignments)
      .values({
        taskId,
        resourceId: input.resourceId,
        allocationPercent: input.allocationPercent,
      })
      .$returningId();

    await writeAudit({
      userId: null,
      entityType: 'assignment:external',
      entityId: created!.id,
      action: 'create',
      diff: { apiKeyId: req.apiKey!.id, taskId, resourceId: input.resourceId },
    });
    await enqueueJob('schedule.compute', { projectId, reason: 'assignment.created' });
    broadcastToProject(projectId, REALTIME_EVENTS.TASK_CHANGED, {
      taskId,
      projectId,
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

  return router;
}
