import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CONSTRAINT_TYPES,
  DEPENDENCY_TYPES,
  HEALTH_SEVERITIES,
  PRIORITIES,
  TASK_STATUSES,
} from '@projectplaner/shared';
import {
  ApiError,
  UnsupportedOperationError,
  type GanttPayload,
  type ProjectDto,
  type ResourceDto,
  type TaskApi,
  type TaskDto,
} from './api/types.js';

const DEFAULT_TASK_LIMIT = 200;
const MAX_TASK_LIMIT = 2_000;
const DEFAULT_ISSUE_LIMIT = 100;
const MAX_ISSUES = 1_000;

// ---------------------------------------------------------------------------
// Kompakte Ausgaben
// ---------------------------------------------------------------------------

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const problem = error.problem;
    if (problem !== null && typeof problem === 'object') {
      const errors = (problem as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const details = errors
          .map((entry) =>
            entry !== null && typeof entry === 'object'
              ? `${String((entry as { path?: unknown }).path ?? '?')}: ${String((entry as { message?: unknown }).message ?? '')}`
              : String(entry),
          )
          .join('; ');
        return `HTTP ${error.status}: ${error.message} (${details})`;
      }
    }
    return `HTTP ${error.status}: ${error.message}`;
  }
  if (error instanceof UnsupportedOperationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Führt einen Tool-Handler aus und verpackt Fehler als MCP-Tool-Fehler. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
  }
}

function pickProject(project: ProjectDto) {
  return {
    id: project.id,
    name: project.name,
    status: project.status ?? null,
    timezone: project.timezone ?? null,
    myRole: project.myRole ?? null,
  };
}

function pickTask(task: TaskDto) {
  return {
    id: task.id,
    name: task.name,
    parentId: task.parentId,
    estimatedMinutes: task.estimatedMinutes,
    isMilestone: task.isMilestone,
    status: task.status,
    priority: task.priority ?? null,
    constraintType: task.constraintType,
    constraintDate: task.constraintDate ?? null,
    plannedStart: task.plannedStart ?? null,
    plannedEnd: task.plannedEnd ?? null,
    resourceIds: (task.assignments ?? []).map((assignment) => assignment.resourceId),
    tags: (task.tags ?? []).map((tag) => tag.name),
  };
}

function pickResource(resource: ResourceDto) {
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    capacityMinutesPerDay: resource.capacityMinutesPerDay,
    isActive: resource.isActive,
  };
}

// ---------------------------------------------------------------------------
// Baum-/Filter-Hilfen für list_tasks
// ---------------------------------------------------------------------------

interface TaskNode {
  task: TaskDto;
  children: TaskNode[];
}

function buildTree(tasks: TaskDto[]): TaskNode[] {
  const nodes = new Map<number, TaskNode>(
    tasks.map((task) => [task.id, { task, children: [] as TaskNode[] }]),
  );
  const roots: TaskNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    const parent = task.parentId !== null ? nodes.get(task.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Ergänzt die Elternkette der Treffer, damit die Hierarchie erhalten bleibt. */
function withAncestors(matched: TaskDto[], all: TaskDto[]): TaskDto[] {
  const byId = new Map(all.map((task) => [task.id, task]));
  const keep = new Set<number>();
  for (const task of matched) {
    let cursor: TaskDto | undefined = task;
    while (cursor && !keep.has(cursor.id)) {
      keep.add(cursor.id);
      cursor = cursor.parentId !== null ? byId.get(cursor.parentId) : undefined;
    }
  }
  // Reihenfolge der API (sortOrder) beibehalten.
  return all.filter((task) => keep.has(task.id));
}

function serializeTree(nodes: TaskNode[], limit: number): { items: unknown[]; returned: number } {
  let returned = 0;
  const walk = (list: TaskNode[]): unknown[] => {
    const out: unknown[] = [];
    for (const node of list) {
      if (returned >= limit) break;
      returned += 1;
      out.push({ ...pickTask(node.task), children: walk(node.children) });
    }
    return out;
  };
  return { items: walk(nodes), returned };
}

// ---------------------------------------------------------------------------
// Gantt-Zusammenfassung
// ---------------------------------------------------------------------------

function summarizeGantt(payload: GanttPayload) {
  const tasks = payload.tasks;
  const scheduled = tasks.filter((task) => task.plannedStart !== null || task.isMilestone);
  const starts = tasks
    .map((task) => task.plannedStart)
    .filter((value): value is string => value !== null);
  const ends = tasks
    .map((task) => task.plannedEnd)
    .filter((value): value is string => value !== null);

  const utilization = payload.utilization;
  let utilizationSummary: {
    from: string;
    to: string;
    bucketMinutes: number;
    maxUtilizationPercent: number;
    overloadedResources: Array<{
      resourceId: number;
      name: string | null;
      peakPercent: number;
      peakAt: string;
    }>;
  } | null = null;

  if (utilization) {
    const names = new Map(payload.resources.map((resource) => [resource.id, resource.name]));
    const peak = new Map<number, { percent: number; at: string }>();
    let maxPercent = 0;
    for (const bucket of utilization.buckets) {
      if (bucket.capacityMinutes <= 0) continue;
      const percent = (bucket.allocatedMinutes / bucket.capacityMinutes) * 100;
      if (percent > maxPercent) maxPercent = percent;
      const current = peak.get(bucket.resourceId);
      if (!current || percent > current.percent) {
        peak.set(bucket.resourceId, { percent, at: bucket.start });
      }
    }
    const overloaded = [...peak.entries()]
      .filter(([, value]) => value.percent > 100.5)
      .map(([resourceId, value]) => ({
        resourceId,
        name: names.get(resourceId) ?? null,
        peakPercent: Math.round(value.percent),
        peakAt: value.at,
      }))
      .sort((a, b) => b.peakPercent - a.peakPercent)
      .slice(0, 20);

    utilizationSummary = {
      from: utilization.from,
      to: utilization.to,
      bucketMinutes: utilization.bucketMinutes,
      maxUtilizationPercent: Math.round(maxPercent),
      overloadedResources: overloaded,
    };
  }

  return {
    project: { id: payload.project.id, name: payload.project.name, timezone: payload.project.timezone },
    scheduleVersion: payload.version,
    taskCount: tasks.length,
    milestoneCount: tasks.filter((task) => task.isMilestone).length,
    scheduledTaskCount: scheduled.length,
    unscheduledTaskCount: tasks.length - scheduled.length,
    criticalTaskCount: tasks.filter((task) => task.critical).length,
    edgeCount: payload.edges.length,
    resourceCount: payload.resources.length,
    assignmentCount: payload.assignments.length,
    earliestStart: starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null,
    latestEnd: ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    utilization: utilizationSummary,
  };
}

// ---------------------------------------------------------------------------
// Tool-Registrierung
// ---------------------------------------------------------------------------

const projectIdSchema = z.number().int().positive().describe('Projekt-ID');

/**
 * Registriert alle ProjectPlaner-Tools am MCP-Server. Alle Antworten sind
 * kompakte JSON-Strings; Fehler kommen als MCP-Tool-Fehler zurück.
 */
export function registerTools(server: McpServer, api: TaskApi): void {
  server.registerTool(
    'list_projects',
    {
      title: 'Projekte auflisten',
      description:
        'Listet die für den Service-Account sichtbaren Projekte (ID, Name, Status, Zeitzone, Rolle).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => ({ projects: (await api.listProjects()).map(pickProject) })),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Projekt mit Aufgaben und Ressourcen',
      description:
        'Liefert ein Projekt mit Mitgliedern, kompakter Aufgabenliste und Ressourcen. ' +
        'Aufgabenliste ggf. auf 500 Einträge gekürzt (truncated).',
      inputSchema: { projectId: projectIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) =>
      run(async () => {
        const [{ project, members }, tasks, resources] = await Promise.all([
          api.getProject(projectId),
          api.listTasks(projectId),
          api.listResources(projectId),
        ]);
        const limited = tasks.slice(0, 500);
        return {
          project: {
            ...pickProject(project),
            description: project.description ?? null,
            workweek: project.workweek ?? null,
            workdayStart: project.workdayStart ?? null,
            workdayEnd: project.workdayEnd ?? null,
            scheduleAnchor: project.scheduleAnchor ?? null,
            version: project.version ?? null,
          },
          members: (members as Array<Record<string, unknown>>).map((member) => ({
            userId: member.userId,
            name: member.name,
            role: member.role,
          })),
          taskCount: tasks.length,
          tasksTruncated: tasks.length > limited.length,
          tasks: limited.map(pickTask),
          resources: resources.map(pickResource),
        };
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'Aufgaben auflisten',
      description:
        'Listet Aufgaben eines Projekts als Baum (Standard) oder flach, optional gefiltert ' +
        'nach Status, Elternaufgabe, Ressource und Namenssuche. Bei Baum-Filter bleiben die ' +
        `Eltern der Treffer enthalten. Maximal ${MAX_TASK_LIMIT} Einträge.`,
      inputSchema: {
        projectId: projectIdSchema,
        tree: z.boolean().optional().describe('Verschachtelte Ausgabe (Standard true)'),
        status: z.enum(TASK_STATUSES).optional().describe('Nur Aufgaben mit diesem Status'),
        parentId: z.number().int().positive().optional().describe('Nur direkte Kinder dieser Aufgabe'),
        resourceId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Nur Aufgaben mit Zuteilung dieser Ressource'),
        query: z.string().min(1).optional().describe('Teilstring im Aufgabennamen (Groß-/Kleinschreibung egal)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TASK_LIMIT)
          .optional()
          .describe(`Maximale Anzahl Einträge (Standard ${DEFAULT_TASK_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, tree, status, parentId, resourceId, query, limit }) =>
      run(async () => {
        const all = await api.listTasks(projectId);
        const useTree = tree ?? true;
        const max = limit ?? DEFAULT_TASK_LIMIT;
        const needle = query?.toLowerCase();

        let matched = all.filter((task) => {
          if (status !== undefined && task.status !== status) return false;
          if (parentId !== undefined && task.parentId !== parentId) return false;
          if (resourceId !== undefined) {
            const assigned = (task.assignments ?? []).some(
              (assignment) => assignment.resourceId === resourceId,
            );
            if (!assigned) return false;
          }
          if (needle !== undefined && !task.name.toLowerCase().includes(needle)) return false;
          return true;
        });
        if (useTree && (parentId !== undefined || resourceId !== undefined || needle !== undefined || status !== undefined)) {
          matched = withAncestors(matched, all);
        }

        if (!useTree) {
          const items = matched.slice(0, max).map(pickTask);
          return {
            mode: 'flat',
            totalCount: matched.length,
            returned: items.length,
            truncated: items.length < matched.length,
            items,
          };
        }

        const { items, returned } = serializeTree(buildTree(matched), max);
        return {
          mode: 'tree',
          totalCount: matched.length,
          returned,
          truncated: returned < matched.length,
          items,
        };
      }),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Aufgabe anlegen',
      description:
        'Legt eine Aufgabe (optional als Unteraufgabe) mit Schätzung, Status, Priorität und ' +
        'Constraint an. constraintType "start_no_earlier_than"/"start_on" erfordert constraintDate.',
      inputSchema: {
        projectId: projectIdSchema,
        name: z.string().min(1).max(255),
        parentId: z.number().int().positive().optional().describe('ID der Oberaufgabe'),
        description: z.string().max(20_000).optional(),
        estimatedMinutes: z.number().int().min(0).optional().describe('Dauer in Minuten'),
        isMilestone: z.boolean().optional().describe('Meilenstein (Dauer 0)'),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        constraintType: z.enum(CONSTRAINT_TYPES).optional(),
        constraintDate: z
          .string()
          .min(1)
          .optional()
          .describe('ISO-8601-Datum/-Zeit, z. B. 2026-01-15T08:00:00Z'),
      },
    },
    async (input) =>
      run(async () => {
        const { projectId, ...rest } = input;
        const { task } = await api.createTask(projectId, rest);
        return { task: pickTask(task) };
      }),
  );

  server.registerTool(
    'add_dependency',
    {
      title: 'Abhängigkeit anlegen',
      description:
        'Verbindet Vorgänger und Nachfolger (FS/SS/FF/SF, Standard FS) mit optionalem Lag in ' +
        'Minuten (auch negativ). Zyklen werden von der API abgelehnt.',
      inputSchema: {
        projectId: projectIdSchema,
        predecessorId: z.number().int().positive(),
        successorId: z.number().int().positive(),
        type: z.enum(DEPENDENCY_TYPES).optional().describe('Standard FS'),
        lagMinutes: z.number().int().optional().describe('Standard 0'),
      },
    },
    async ({ projectId, predecessorId, successorId, type, lagMinutes }) =>
      run(async () => {
        const { dependency } = await api.addDependency(projectId, {
          predecessorId,
          successorId,
          type: type ?? 'FS',
          lagMinutes: lagMinutes ?? 0,
        });
        return {
          dependency: {
            id: dependency.id,
            predecessorId: dependency.predecessorId,
            successorId: dependency.successorId,
            type: dependency.type,
            lagMinutes: dependency.lagMinutes,
          },
        };
      }),
  );

  server.registerTool(
    'assign_resource',
    {
      title: 'Ressource zuteilen',
      description:
        'Teilt einer Aufgabe eine Ressource zu (Auslastung 1–400 %, Standard 100). ' +
        'Duplikate werden von der API abgelehnt.',
      inputSchema: {
        projectId: projectIdSchema,
        taskId: z.number().int().positive(),
        resourceId: z.number().int().positive(),
        allocationPercent: z.number().int().min(1).max(400).optional().describe('Standard 100'),
      },
    },
    async ({ projectId, taskId, resourceId, allocationPercent }) =>
      run(async () => {
        const { assignment } = await api.assignResource(projectId, taskId, {
          resourceId,
          allocationPercent: allocationPercent ?? 100,
        });
        return {
          assignment: {
            id: assignment.id,
            taskId,
            resourceId: assignment.resourceId,
            allocationPercent: assignment.allocationPercent,
          },
        };
      }),
  );

  server.registerTool(
    'compute_schedule',
    {
      title: 'Planung neu berechnen',
      description:
        'Stößt die CPM-Neuberechnung des Projekts an und liefert Version, Aufgabenzahl und ' +
        'Anzahl zyklischer Aufgaben. Danach planen get_gantt_summary/get_health den frischen Stand.',
      inputSchema: { projectId: projectIdSchema },
    },
    async ({ projectId }) => run(async () => await api.computeSchedule(projectId)),
  );

  server.registerTool(
    'get_health',
    {
      title: 'Planungsprüfung („fertig geplant")',
      description:
        'Liefert die Health-Findings des Projekts (Schätzungen, Ressourcen, Zyklen, ' +
        'Überbelegung …) inklusive Zusammenfassung pro Severity.',
      inputSchema: {
        projectId: projectIdSchema,
        severity: z.enum(HEALTH_SEVERITIES).optional().describe('Nur Findings dieser Severity'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ISSUES)
          .optional()
          .describe(`Maximale Anzahl Findings (Standard ${DEFAULT_ISSUE_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, severity, limit }) =>
      run(async () => {
        const payload = await api.getHealth(projectId);
        const max = limit ?? DEFAULT_ISSUE_LIMIT;
        const filtered =
          severity !== undefined
            ? payload.issues.filter((issue) => issue.severity === severity)
            : payload.issues;
        return {
          summary: payload.summary,
          totalCount: filtered.length,
          truncated: filtered.length > max,
          issues: filtered.slice(0, max),
        };
      }),
  );

  server.registerTool(
    'get_gantt_summary',
    {
      title: 'Gantt-Zusammenfassung',
      description:
        'Komprimierte Gantt-Auswertung: Zeitraum, Anzahl geplanter/kritischer Aufgaben, ' +
        'Meilensteine und Spitzen-Auslastung je Ressource (nur bei Service-Login verfügbar). ' +
        'from/to sind optionale ISO-8601-Grenzen für die Auslastungsfenster.',
      inputSchema: {
        projectId: projectIdSchema,
        from: z.string().min(1).optional().describe('ISO-8601, z. B. 2026-01-01T00:00:00Z'),
        to: z.string().min(1).optional().describe('ISO-8601, z. B. 2026-03-31T23:59:59Z'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, from, to }) =>
      run(async () => summarizeGantt(await api.getGantt(projectId, { from, to }))),
  );
}

/** Anzahl registrierter Tools (für Smoke-Tests). */
export const TOOL_NAMES = [
  'list_projects',
  'get_project',
  'list_tasks',
  'create_task',
  'add_dependency',
  'assign_resource',
  'compute_schedule',
  'get_health',
  'get_gantt_summary',
] as const;
