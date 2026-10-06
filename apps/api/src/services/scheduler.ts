import { sql } from 'drizzle-orm';
import type { DateTime } from 'luxon';
import type { DependencyType } from '@projectplaner/shared';
import { db, pool } from '../db/client.js';
import { assignments, tasks } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { topologicalOrder, type DepEdge } from './dependencyGraph.js';
import {
  loadPlanningData,
  type AssignmentRow,
  type PlanningData,
  type TaskRow,
} from './planningData.js';

export interface ComputeScheduleResult {
  projectId: number;
  version: number;
  taskCount: number;
  cyclicCount: number;
  computedAt: string;
}

export interface ScheduleTaskDto {
  id: number;
  parentId: number | null;
  name: string;
  estimatedMinutes: number | null;
  isMilestone: boolean;
  status: TaskRow['status'];
  progress: number;
  constraintType: TaskRow['constraintType'];
  constraintDate: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  scheduleVersion: number;
  critical: boolean;
  slackMinutes: number;
}

export interface SchedulePayload {
  project: {
    id: number;
    name: string;
    timezone: string;
    workweek: number[];
    workdayStart: string;
    workdayEnd: string;
    scheduleAnchor: string | null;
    version: number;
  };
  version: number;
  tasks: ScheduleTaskDto[];
  edges: Array<{
    id: number;
    predecessorId: number;
    successorId: number;
    type: DependencyType;
    lagMinutes: number;
  }>;
  resources: Array<{
    id: number;
    name: string;
    type: 'person' | 'machine';
    color: string | null;
    capacityMinutesPerDay: number;
    email: string | null;
  }>;
  assignments: Array<{
    id: number;
    taskId: number;
    resourceId: number;
    allocationPercent: number;
    plannedStart: string | null;
    plannedEnd: string | null;
  }>;
}

export function taskDurationMinutes(task: TaskRow): number {
  if (task.isMilestone) return 0;
  return task.estimatedMinutes ?? 0;
}

function shift(calendar: PlanningData['calendar'], moment: DateTime, minutes: number): DateTime {
  return minutes >= 0
    ? calendar.addWorkingMinutes(moment, minutes)
    : calendar.subtractWorkingMinutes(moment, -minutes);
}

function isScheduled(task: TaskRow): boolean {
  return task.estimatedMinutes !== null || task.isMilestone;
}

export function childrenMap(tasks: TaskRow[]): Map<number, TaskRow[]> {
  const children = new Map<number, TaskRow[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const list = children.get(task.parentId) ?? [];
    list.push(task);
    children.set(task.parentId, list);
  }
  return children;
}

export function isSummaryTask(
  task: TaskRow,
  children: Map<number, TaskRow[]>,
): boolean {
  return (
    task.estimatedMinutes === null && !task.isMilestone && (children.get(task.id)?.length ?? 0) > 0
  );
}

/**
 * Abhängigkeitskanten plus Rollup-Kanten (Kind → Summary-Eltern).
 * Summary-Aufgaben werden erst nach ihren Kindern geplant; ihre Dauer ergibt
 * sich aus dem Zeitraum der Kinder.
 */
export function buildCombinedEdges(tasks: TaskRow[], edges: DepEdge[]): DepEdge[] {
  const children = childrenMap(tasks);
  const combined: DepEdge[] = [...edges];
  for (const task of tasks) {
    if (!isSummaryTask(task, children)) continue;
    for (const child of children.get(task.id) ?? []) {
      combined.push({
        id: -child.id,
        predecessorId: child.id,
        successorId: task.id,
        type: 'FS',
        lagMinutes: 0,
      });
    }
  }
  return combined;
}

export interface PlanInput {
  tasks: TaskRow[];
  edges: DepEdge[];
  calendar: PlanningData['calendar'];
  anchor: string | null;
}

export interface PlanResult {
  /** Geplante Zeiten je Aufgabe (null = nicht planbar, z. B. ohne Schätzung/Zyklus). */
  planned: Map<number, { start: DateTime | null; end: DateTime | null }>;
  cyclic: Set<number>;
}

/**
 * CPM-Vorwärtspass mit Arbeitskalender, zweiphasiger Summary-Propagation und
 * kombiniertem Abhängigkeits-/Hierarchie-Graph (reine Funktion, testbar ohne DB).
 */
export function buildPlan(input: PlanInput): PlanResult {
  const { tasks: taskRows, edges, calendar, anchor: anchorIso } = input;
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const children = childrenMap(taskRows);
  const combinedEdges = buildCombinedEdges(taskRows, edges);
  const { order, cyclic } = topologicalOrder(
    taskRows.map((t) => t.id),
    combinedEdges,
  );

  // Kalendertage für den Planungshorizont einmalig materialisieren
  // (Anker ± Constraints plus Obergrenze der Serialisierung).
  const anchorForRange = calendar.anchorMoment(anchorIso);
  const totalMinutes = taskRows.reduce((sum, t) => sum + taskDurationMinutes(t), 0);
  const constraintTimes = taskRows
    .map((t) => t.constraintDate?.getTime())
    .filter((v): v is number => v !== undefined && v !== null);
  const fromMs = Math.min(anchorForRange.toMillis(), ...constraintTimes) - 2 * 86_400_000;
  const toMs =
    Math.max(anchorForRange.toMillis(), ...constraintTimes) +
    (totalMinutes * 2 + 180 * 24 * 60) * 60_000;
  calendar.precomputeRange(fromMs, toMs);

  const incoming = new Map<number, DepEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.successorId) ?? [];
    list.push(edge);
    incoming.set(edge.successorId, list);
  }

  const anchor = calendar.anchorMoment(anchorIso);
  const ES = new Map<number, DateTime>();
  const EF = new Map<number, DateTime>();

  const constraintMoment = (task: TaskRow): DateTime => {
    if (task.constraintType === 'start_on' && task.constraintDate) {
      return calendar.nextWorkingMoment(calendar.fromDate(task.constraintDate));
    }
    if (task.constraintType === 'start_no_earlier_than' && task.constraintDate) {
      const candidate = calendar.nextWorkingMoment(calendar.fromDate(task.constraintDate));
      return candidate > anchor ? candidate : anchor;
    }
    return anchor;
  };

  for (const id of order) {
    const task = taskById.get(id);
    if (!task) continue;

    const duration = taskDurationMinutes(task);
    let es = constraintMoment(task);

    for (const edge of incoming.get(id) ?? []) {
      const predES = ES.get(edge.predecessorId);
      const predEF = EF.get(edge.predecessorId);
      if (!predES || !predEF) continue; // Vorgänger zyklisch oder ohne Plan

      let candidate: DateTime;
      switch (edge.type) {
        case 'FS':
          candidate = shift(calendar, predEF, edge.lagMinutes);
          break;
        case 'SS':
          candidate = shift(calendar, predES, edge.lagMinutes);
          break;
        case 'FF': {
          const finish = shift(calendar, predEF, edge.lagMinutes);
          candidate = calendar.subtractWorkingMinutes(finish, duration);
          break;
        }
        case 'SF': {
          const finish = shift(calendar, predES, edge.lagMinutes);
          candidate = calendar.subtractWorkingMinutes(finish, duration);
          break;
        }
      }
      if (candidate > es) es = candidate;
    }

    if (isSummaryTask(task, children)) {
      // Kinder wurden dank Rollup-Kanten bereits geplant.
      let minChildES: DateTime | null = null;
      let maxChildEF: DateTime | null = null;
      for (const child of children.get(task.id) ?? []) {
        const childES = ES.get(child.id);
        const childEF = EF.get(child.id);
        if (!childES || !childEF) continue;
        if (!minChildES || childES < minChildES) minChildES = childES;
        if (!maxChildEF || childEF > maxChildEF) maxChildEF = childEF;
      }
      if (minChildES && minChildES > es) es = minChildES;
      const ef = maxChildEF && maxChildEF > es ? maxChildEF : es;
      ES.set(id, es);
      EF.set(id, ef);
      continue;
    }

    es = calendar.nextWorkingMoment(es);
    EF.set(id, duration > 0 ? calendar.addWorkingMinutes(es, duration) : es);
    ES.set(id, es);
  }

  const planned = new Map<number, { start: DateTime | null; end: DateTime | null }>();
  for (const task of taskRows) {
    const es = ES.get(task.id);
    const ef = EF.get(task.id);
    if ((isSummaryTask(task, children) || isScheduled(task)) && es && ef) {
      planned.set(task.id, { start: es, end: ef });
    } else {
      planned.set(task.id, { start: null, end: null });
    }
  }

  return { planned, cyclic };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const CHUNK_SIZE = 400;

/** Persistiert den Plan mit gebündelten CASE-UPDATEs (statt 2×N Einzel-Updates). */
async function persistPlan(
  version: number,
  taskRows: TaskRow[],
  assignmentRows: AssignmentRow[],
  planned: PlanResult['planned'],
): Promise<void> {
  const taskEntries = taskRows.map((task) => {
    const slot = planned.get(task.id);
    return {
      id: task.id,
      start: slot?.start?.toJSDate() ?? null,
      end: slot?.end?.toJSDate() ?? null,
    };
  });
  const assignmentEntries = assignmentRows.map((assignment) => {
    const slot = planned.get(assignment.taskId);
    return {
      id: assignment.id,
      start: slot?.start?.toJSDate() ?? null,
      end: slot?.end?.toJSDate() ?? null,
    };
  });

  await db.transaction(async (tx) => {
    for (const chunk of chunkArray(taskEntries, CHUNK_SIZE)) {
      const startCases = sql.join(
        chunk.map((entry) => sql`WHEN ${entry.id} THEN ${entry.start}`),
        sql` `,
      );
      const endCases = sql.join(chunk.map((entry) => sql`WHEN ${entry.id} THEN ${entry.end}`), sql` `);
      const ids = sql.join(chunk.map((entry) => sql`${entry.id}`), sql`, `);
      await tx.execute(sql`
        UPDATE ${tasks} SET
          planned_start = CASE id ${startCases} ELSE planned_start END,
          planned_end = CASE id ${endCases} ELSE planned_end END,
          schedule_version = ${version}
        WHERE id IN (${ids})
      `);
    }

    for (const chunk of chunkArray(assignmentEntries, CHUNK_SIZE)) {
      const startCases = sql.join(
        chunk.map((entry) => sql`WHEN ${entry.id} THEN ${entry.start}`),
        sql` `,
      );
      const endCases = sql.join(chunk.map((entry) => sql`WHEN ${entry.id} THEN ${entry.end}`), sql` `);
      const ids = sql.join(chunk.map((entry) => sql`${entry.id}`), sql`, `);
      await tx.execute(sql`
        UPDATE ${assignments} SET
          planned_start = CASE id ${startCases} ELSE planned_start END,
          planned_end = CASE id ${endCases} ELSE planned_end END
        WHERE id IN (${ids})
      `);
    }
  });
}

/**
 * Serialisiert Berechnungen pro Projekt über einen MySQL-Named-Lock:
 * manueller POST /schedule und Worker können sich so nicht gegenseitig
 * mit veralteten Ständen überschreiben.
 */
export async function computeSchedule(projectId: number): Promise<ComputeScheduleResult> {
  const lockName = `pp:schedule:${projectId}`;
  const lockConnection = await pool.getConnection();
  try {
    const [lockRows] = await lockConnection.query('SELECT GET_LOCK(?, 10) AS locked', [lockName]);
    const locked = (lockRows as Array<{ locked: number | null }>)[0]?.locked;
    if (locked !== 1) {
      throw new ApiError(
        503,
        'Planung läuft bereits',
        'Für dieses Projekt wird gerade eine Neuberechnung durchgeführt. Bitte kurz warten.',
      );
    }

    try {
      return await computeScheduleLocked(projectId);
    } finally {
      await lockConnection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } finally {
    lockConnection.release();
  }
}

async function computeScheduleLocked(projectId: number): Promise<ComputeScheduleResult> {
  const data = await loadPlanningData(projectId);
  const { planned, cyclic } = buildPlan({
    tasks: data.tasks,
    edges: data.edges,
    calendar: data.calendar,
    anchor: data.project.scheduleAnchor,
  });

  const version = Math.max(0, ...data.tasks.map((t) => t.scheduleVersion)) + 1;
  const computedAt = new Date();
  await persistPlan(version, data.tasks, data.assignments, planned);

  return {
    projectId,
    version,
    taskCount: data.tasks.length,
    cyclicCount: cyclic.size,
    computedAt: computedAt.toISOString(),
  };
}

interface SlackResult {
  slack: Map<number, number>;
  critical: Set<number>;
}

/** Rückwärtspass auf Basis der persistierten Planzeiten (für kritischen Pfad). */
function computeSlack(data: PlanningData): SlackResult {
  const { calendar, tasks: taskRows, edges } = data;
  const { order } = topologicalOrder(
    taskRows.map((t) => t.id),
    edges,
  );

  // Materialisierte Kalendertage für den gesamten geplanten Zeitraum.
  const starts = taskRows
    .map((t) => t.plannedStart?.getTime())
    .filter((v): v is number => v !== undefined && v !== null);
  const ends = taskRows
    .map((t) => t.plannedEnd?.getTime())
    .filter((v): v is number => v !== undefined && v !== null);
  if (starts.length > 0 && ends.length > 0) {
    calendar.precomputeRange(
      Math.min(...starts) - 2 * 86_400_000,
      Math.max(...ends) + 2 * 86_400_000,
    );
  }

  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const children = childrenMap(taskRows);
  const outgoing = new Map<number, DepEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.predecessorId) ?? [];
    list.push(edge);
    outgoing.set(edge.predecessorId, list);
  }

  const shiftMs = (ms: number, minutes: number): number =>
    minutes >= 0 ? calendar.addWorkingMs(ms, minutes) : calendar.subtractWorkingMs(ms, -minutes);

  let projectEndMs: number | null = null;
  for (const task of taskRows) {
    if (!task.plannedEnd) continue;
    const endMs = task.plannedEnd.getTime();
    if (projectEndMs === null || endMs > projectEndMs) projectEndMs = endMs;
  }

  const LF = new Map<number, number>();
  const LS = new Map<number, number>();
  const slack = new Map<number, number>();

  for (const id of [...order].reverse()) {
    const task = taskById.get(id);
    if (!task?.plannedStart || !task.plannedEnd) continue;
    const duration = taskDurationMinutes(task);

    const candidates: number[] = [];
    for (const edge of outgoing.get(id) ?? []) {
      const succLS = LS.get(edge.successorId);
      const succLF = LF.get(edge.successorId);
      if (succLS === undefined || succLF === undefined) continue;
      switch (edge.type) {
        case 'FS':
          candidates.push(shiftMs(succLS, -edge.lagMinutes));
          break;
        case 'SS':
          candidates.push(calendar.addWorkingMs(shiftMs(succLS, -edge.lagMinutes), duration));
          break;
        case 'FF':
          candidates.push(shiftMs(succLF, -edge.lagMinutes));
          break;
        case 'SF':
          candidates.push(calendar.addWorkingMs(shiftMs(succLF, -edge.lagMinutes), duration));
          break;
      }
    }

    const lf =
      candidates.length > 0
        ? candidates.reduce((min, c) => (c < min ? c : min), candidates[0]!)
        : (projectEndMs ?? task.plannedEnd.getTime());
    const ls = calendar.subtractWorkingMs(lf, duration);

    LF.set(id, lf);
    LS.set(id, ls);
    slack.set(id, Math.round(calendar.workingMinutesBetweenMs(task.plannedStart.getTime(), ls)));
  }

  // Summary-Aufgaben erben den kleinsten Puffer ihrer Kinder (Kinder zuerst).
  const depthOf = (task: TaskRow): number => {
    let depth = 0;
    let current: TaskRow | undefined = task;
    const seen = new Set<number>();
    while (current?.parentId != null && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = taskById.get(current.parentId);
      depth += 1;
    }
    return depth;
  };
  const summaries = taskRows
    .filter((task) => isSummaryTask(task, children))
    .sort((a, b) => depthOf(b) - depthOf(a));
  for (const summary of summaries) {
    const childSlacks = (children.get(summary.id) ?? [])
      .map((child) => slack.get(child.id))
      .filter((value): value is number => value !== undefined);
    if (childSlacks.length > 0) {
      slack.set(summary.id, Math.min(...childSlacks));
    }
  }

  const critical = new Set<number>();
  for (const [id, value] of slack) {
    if (value <= 0) critical.add(id);
  }
  return { slack, critical };
}

export async function getSchedulePayload(
  projectId: number,
  preloaded?: PlanningData,
): Promise<SchedulePayload> {
  const data = preloaded ?? (await loadPlanningData(projectId));
  const { slack, critical } = computeSlack(data);
  const version = Math.max(0, ...data.tasks.map((t) => t.scheduleVersion));

  return {
    project: {
      id: data.project.id,
      name: data.project.name,
      timezone: data.project.timezone,
      workweek: data.project.workweek,
      workdayStart: data.project.workdayStart,
      workdayEnd: data.project.workdayEnd,
      scheduleAnchor: data.project.scheduleAnchor,
      version: data.project.version,
    },
    version,
    tasks: data.tasks.map((task) => ({
      id: task.id,
      parentId: task.parentId,
      name: task.name,
      estimatedMinutes: task.estimatedMinutes,
      isMilestone: task.isMilestone,
      status: task.status,
      progress: task.progress,
      constraintType: task.constraintType,
      constraintDate: task.constraintDate?.toISOString() ?? null,
      plannedStart: task.plannedStart?.toISOString() ?? null,
      plannedEnd: task.plannedEnd?.toISOString() ?? null,
      scheduleVersion: task.scheduleVersion,
      critical: critical.has(task.id),
      slackMinutes: slack.get(task.id) ?? 0,
    })),
    edges: data.edges.map((edge) => ({
      id: edge.id,
      predecessorId: edge.predecessorId,
      successorId: edge.successorId,
      type: edge.type,
      lagMinutes: edge.lagMinutes,
    })),
    resources: data.resources.map((resource) => ({
      id: resource.id,
      name: resource.name,
      type: resource.type,
      color: resource.color,
      capacityMinutesPerDay: resource.capacityMinutesPerDay,
      email: resource.email,
    })),
    assignments: data.assignments.map((assignment) => ({
      id: assignment.id,
      taskId: assignment.taskId,
      resourceId: assignment.resourceId,
      allocationPercent: assignment.allocationPercent,
      plannedStart: assignment.plannedStart?.toISOString() ?? null,
      plannedEnd: assignment.plannedEnd?.toISOString() ?? null,
    })),
  };
}
