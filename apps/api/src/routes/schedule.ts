import { Router } from 'express';
import { DateTime } from 'luxon';
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

const TIMELINE_YEARS = 5;
const TO_PADDING_MS = 30 * 86_400_000;

/**
 * Fester Achsen-Ursprung (Variante A): Der Projektanker ist die Referenz,
 * früher geplante Aufgaben erweitern die Achse nur nach links. Das Ende reicht
 * mindestens 5 Jahre in die Zukunft (bzw. weiter, wenn tatsächlich so weit
 * geplant wird), damit sich die Achse nicht bei jeder Änderung verschiebt.
 */
export function timelineRange(data: PlanningData): { from: Date; to: Date } {
  const anchor = data.project.scheduleAnchor
    ? data.calendar.fromISO(data.project.scheduleAnchor).startOf('day')
    : DateTime.now().setZone(data.project.timezone).startOf('day');
  const anchorMs = anchor.toMillis();

  const starts = data.tasks
    .map((t) => t.plannedStart?.getTime())
    .filter((v): v is number => v !== undefined && v !== null && !Number.isNaN(v));
  const ends = data.tasks
    .map((t) => t.plannedEnd?.getTime())
    .filter((v): v is number => v !== undefined && v !== null && !Number.isNaN(v));

  const minStart = starts.length > 0 ? Math.min(...starts) : anchorMs;
  const maxEnd = ends.length > 0 ? Math.max(...ends) : anchorMs;

  const from = Math.min(anchorMs, minStart) - 2 * 86_400_000;
  const fiveYears = anchor.plus({ years: TIMELINE_YEARS }).toMillis();
  const to = Math.max(fiveYears, maxEnd + TO_PADDING_MS);

  return { from: new Date(Math.floor(from)), to: new Date(Math.ceil(to)) };
}

/** Obergrenze für Kapazitäts-/Belegungs-Buckets (nicht die volle 5-Jahres-Achse). */
function utilizationRange(data: PlanningData, from: Date, to: Date): { from: Date; to: Date } {
  const ends = data.tasks
    .map((t) => t.plannedEnd?.getTime())
    .filter((v): v is number => v !== undefined && v !== null && !Number.isNaN(v));
  const lastEnd = ends.length > 0 ? Math.max(...ends) : from.getTime();
  const cap = new Date(lastEnd + 90 * 86_400_000);
  return { from, to: cap.getTime() < to.getTime() ? cap : to };
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

  /**
   * Schlanker Gantt-Payload: Aufgaben-Stammdaten kommen aus /tasks?tree=1,
   * hier nur die berechneten Zusatzinfos (kritisch/Puffer), Kanten und
   * Abwesenheiten. Auslastung liegt unter /utilisation (zoomabhängig).
   */
  router.get('/projects/:projectId/gantt', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);

    const data = await loadPlanningData(projectId);
    const payload = await getSchedulePayload(projectId, data);
    const etag = `"gv${payload.version}"`;

    // Unveränderte Planversion → 304, der Client behält seine Daten.
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const absenceItems = data.absences.map((absence) => ({
      id: absence.id,
      resourceId: absence.resourceId,
      startDate: absence.startDate,
      endDate: absence.endDate,
      type: absence.type,
      name: absence.name,
    }));

    res.set('ETag', etag);
    res.json({
      project: payload.project,
      version: payload.version,
      tasks: payload.tasks.map((task) => ({
        id: task.id,
        critical: task.critical,
        slackMinutes: task.slackMinutes,
      })),
      edges: payload.edges,
      absences: absenceItems,
    });
  });

  /** Zoomabhängige Ressourcen-Auslastung (separater, leichter Endpoint). */
  router.get('/projects/:projectId/utilisation', async (req, res) => {
    const projectId = parseId(req.params.projectId, 'projectId');
    await ensureProjectAccess(projectId, req.user!);
    const query = parse(ganttQuerySchema, req.query);

    const data = await loadPlanningData(projectId);
    const defaults = timelineRange(data);
    const requestedFrom = query.from ?? defaults.from;
    const requestedTo = query.to ?? defaults.to;
    const bucketMinutes =
      query.bucketMinutes ?? chooseBucketMinutes(requestedTo.getTime() - requestedFrom.getTime());

    const bounded = utilizationRange(data, requestedFrom, requestedTo);
    const utilization = buildUtilization(data, bounded.from, bounded.to, bucketMinutes);
    res.json(utilization);
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
