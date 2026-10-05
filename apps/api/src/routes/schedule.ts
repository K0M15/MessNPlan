import { Router } from 'express';
import { ganttQuerySchema, REALTIME_EVENTS, scheduleComputeSchema } from '@projectplaner/shared';
import { requireAuth } from '../http/auth.js';
import { parse, parseId } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureProjectAccess } from '../services/access.js';
import { loadPlanningData, type PlanningData } from '../services/planningData.js';
import { detectIssues, summarizeIssues } from '../services/planningHealth.js';
import { computeSchedule, getSchedulePayload } from '../services/scheduler.js';
import { buildUtilization } from '../services/utilization.js';

function chooseBucketMinutes(spanMs: number): number {
  const days = spanMs / 86_400_000;
  if (days <= 2) return 60; // Stunden
  if (days <= 14) return 240; // 4 Stunden
  if (days <= 120) return 1440; // Tage
  if (days <= 800) return 10_080; // Wochen
  return 43_200; // Monate (30 Tage)
}

function defaultRange(data: PlanningData): { from: Date; to: Date } {
  const starts = data.tasks
    .map((t) => t.plannedStart?.getTime())
    .filter((v): v is number => v !== undefined && v !== null && !Number.isNaN(v));
  const ends = data.tasks
    .map((t) => t.plannedEnd?.getTime())
    .filter((v): v is number => v !== undefined && v !== null && !Number.isNaN(v));

  const now = Date.now();
  const from = starts.length > 0 ? new Date(Math.min(...starts)) : new Date(now - 7 * 86_400_000);
  const to = ends.length > 0 ? new Date(Math.max(...ends)) : new Date(now + 30 * 86_400_000);
  return {
    from: new Date(from.getTime() - 2 * 86_400_000),
    to: new Date(to.getTime() + 2 * 86_400_000),
  };
}

export function scheduleRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/projects/:projectId/schedule', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!, 'member');
    parse(scheduleComputeSchema, req.body ?? {});
    const result = await computeSchedule(projectId);
    broadcastToProject(projectId, REALTIME_EVENTS.SCHEDULE_UPDATED, result);
    res.json({ result });
  });

  router.get('/projects/:projectId/schedule', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);
    res.json(await getSchedulePayload(projectId));
  });

  router.get('/projects/:projectId/gantt', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);
    const query = parse(ganttQuerySchema, req.query);

    const data = await loadPlanningData(projectId);
    const payload = await getSchedulePayload(projectId, data);

    const defaults = defaultRange(data);
    const from = query.from ?? defaults.from;
    const to = query.to ?? defaults.to;
    const bucketMinutes = query.bucketMinutes ?? chooseBucketMinutes(to.getTime() - from.getTime());

    const utilization = buildUtilization(data, from, to, bucketMinutes);

    res.json({ ...payload, utilization });
  });

  router.get('/projects/:projectId/health', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);
    const data = await loadPlanningData(projectId);
    const issues = detectIssues(data);
    res.json({ issues, summary: summarizeIssues(issues) });
  });

  return router;
}
