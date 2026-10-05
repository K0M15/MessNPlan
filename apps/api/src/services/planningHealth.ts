import { DateTime } from 'luxon';
import {
  HEALTH_RULES,
  type HealthRule,
  type HealthSeverity,
} from '@projectplaner/shared';
import { topologicalOrder } from './dependencyGraph.js';
import type { PlanningData, TaskRow } from './planningData.js';
import { buildCombinedEdges, taskDurationMinutes } from './scheduler.js';

export interface HealthIssue {
  rule: HealthRule;
  severity: HealthSeverity;
  message: string;
  taskId?: number;
  resourceId?: number;
  details?: Record<string, unknown>;
}

export interface HealthSummary {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/** Auslastung pro Ressource und Arbeitstag (Minuten). */
export function computeResourceLoads(data: PlanningData): Map<number, Map<string, number>> {
  const taskById = new Map(data.tasks.map((t) => [t.id, t]));
  const loads = new Map<number, Map<string, number>>();

  for (const assignment of data.assignments) {
    const task = taskById.get(assignment.taskId);
    if (!task?.plannedStart || !task.plannedEnd) continue;
    const duration = taskDurationMinutes(task);
    if (duration <= 0) continue;

    const days = data.calendar.workingDaysBetween(
      data.calendar.fromDate(task.plannedStart),
      data.calendar.fromDate(task.plannedEnd),
    );
    if (days.length === 0) continue;

    const perDay = (duration * assignment.allocationPercent) / 100 / days.length;
    const byDay = loads.get(assignment.resourceId) ?? new Map<string, number>();
    for (const day of days) {
      byDay.set(day, (byDay.get(day) ?? 0) + perDay);
    }
    loads.set(assignment.resourceId, byDay);
  }

  return loads;
}

export function summarizeIssues(issues: HealthIssue[]): HealthSummary {
  const summary: HealthSummary = { error: 0, warning: 0, info: 0, total: issues.length };
  for (const issue of issues) summary[issue.severity] += 1;
  return summary;
}

/**
 * Regelkatalog „fertig geplant": liefert alle Findings eines Projekts.
 */
export function detectIssues(data: PlanningData): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const { tasks, edges, assignments, resources, calendar } = data;
  const now = DateTime.now().setZone(calendar.timezone);

  // Kalendertage für Auslastungsprüfungen materialisieren.
  const plannedStarts = tasks
    .map((t) => t.plannedStart?.getTime())
    .filter((v): v is number => v !== undefined && v !== null);
  const plannedEnds = tasks
    .map((t) => t.plannedEnd?.getTime())
    .filter((v): v is number => v !== undefined && v !== null);
  if (plannedStarts.length > 0 && plannedEnds.length > 0) {
    calendar.precomputeRange(
      Math.min(...plannedStarts) - 2 * 86_400_000,
      Math.max(...plannedEnds) + 2 * 86_400_000,
    );
  }

  const childrenByParent = new Map<number, TaskRow[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const list = childrenByParent.get(task.parentId) ?? [];
    list.push(task);
    childrenByParent.set(task.parentId, list);
  }

  const incoming = new Map<number, number>();
  const outgoing = new Map<number, number>();
  for (const edge of edges) {
    incoming.set(edge.successorId, (incoming.get(edge.successorId) ?? 0) + 1);
    outgoing.set(edge.predecessorId, (outgoing.get(edge.predecessorId) ?? 0) + 1);
  }

  const assignmentsByTask = new Map<number, number>();
  for (const assignment of assignments) {
    assignmentsByTask.set(assignment.taskId, (assignmentsByTask.get(assignment.taskId) ?? 0) + 1);
  }

  const { cyclic } = topologicalOrder(
    tasks.map((t) => t.id),
    buildCombinedEdges(tasks, edges),
  );

  for (const task of tasks) {
    const kids = childrenByParent.get(task.id) ?? [];
    const isLeaf = kids.length === 0;
    const duration = taskDurationMinutes(task);

    if (task.status === 'done') {
      if (kids.some((k) => k.status !== 'done')) {
        issues.push({
          rule: HEALTH_RULES.PARENT_CHILD_MISMATCH,
          severity: 'info',
          message: 'Elternaufgabe ist abgeschlossen, aber Teilaufgaben sind offen',
          taskId: task.id,
        });
      }
      continue;
    }

    if (cyclic.has(task.id)) {
      issues.push({
        rule: HEALTH_RULES.DEPENDENCY_CYCLE,
        severity: 'error',
        message: 'Zyklische Abhängigkeit – Aufgabe kann nicht berechnet werden',
        taskId: task.id,
      });
    }

    if (!task.isMilestone && isLeaf && task.estimatedMinutes === null) {
      issues.push({
        rule: HEALTH_RULES.MISSING_ESTIMATE,
        severity: 'error',
        message: 'Keine Zeitschätzung hinterlegt',
        taskId: task.id,
      });
    }

    if (!task.isMilestone && duration > 0 && (assignmentsByTask.get(task.id) ?? 0) === 0) {
      issues.push({
        rule: HEALTH_RULES.NO_RESOURCE,
        severity: 'warning',
        message: 'Keine Ressource zugewiesen',
        taskId: task.id,
      });
    }

    if (
      isLeaf &&
      task.constraintType === 'asap' &&
      (incoming.get(task.id) ?? 0) === 0 &&
      (outgoing.get(task.id) ?? 0) === 0
    ) {
      issues.push({
        rule: HEALTH_RULES.ORPHAN_TASK,
        severity: 'warning',
        message: 'Weder Vorgänger noch Start-Constraint – Aufgabe hängt in der Luft',
        taskId: task.id,
      });
    }

    if (task.plannedEnd && calendar.fromDate(task.plannedEnd) < now) {
      issues.push({
        rule: HEALTH_RULES.OVERDUE,
        severity: 'warning',
        message: 'Geplantes Ende liegt in der Vergangenheit',
        taskId: task.id,
        details: { plannedEnd: task.plannedEnd.toISOString() },
      });
    }

    if (task.isMilestone && !task.plannedStart) {
      issues.push({
        rule: HEALTH_RULES.MILESTONE_WITHOUT_DATE,
        severity: 'warning',
        message: 'Meilenstein ohne Termin',
        taskId: task.id,
      });
    }
  }

  const loads = computeResourceLoads(data);
  for (const resource of resources) {
    if (!resource.isActive) continue;
    const byDay = loads.get(resource.id);
    if (byDay) {
      let maxDay: string | null = null;
      let maxMinutes = 0;
      for (const [day, minutes] of byDay) {
        if (minutes > maxMinutes) {
          maxMinutes = minutes;
          maxDay = day;
        }
      }
      if (maxDay && maxMinutes > resource.capacityMinutesPerDay + 0.5) {
        issues.push({
          rule: HEALTH_RULES.RESOURCE_OVERALLOCATED,
          severity: 'error',
          message: `Ressource ist am ${maxDay} überbelegt (${Math.round(maxMinutes)} von ${resource.capacityMinutesPerDay} Minuten)`,
          resourceId: resource.id,
          details: {
            day: maxDay,
            allocatedMinutes: Math.round(maxMinutes),
            capacityMinutes: resource.capacityMinutesPerDay,
          },
        });
      }
    }

    if (!resource.email) {
      issues.push({
        rule: HEALTH_RULES.RESOURCE_WITHOUT_EMAIL,
        severity: 'info',
        message: 'Keine E-Mail hinterlegt – Outlook-Sync nicht möglich',
        resourceId: resource.id,
      });
    }
  }

  return issues;
}
