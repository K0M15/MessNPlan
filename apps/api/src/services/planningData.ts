import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  assignments,
  holidays,
  projects,
  resources,
  taskDependencies,
  tasks,
} from '../db/schema.js';
import { notFound } from '../errors.js';
import { WorkCalendar } from './calendar.js';
import type { DepEdge } from './dependencyGraph.js';

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ResourceRow = typeof resources.$inferSelect;
export type AssignmentRow = typeof assignments.$inferSelect;

export interface PlanningData {
  project: ProjectRow;
  tasks: TaskRow[];
  edges: DepEdge[];
  resources: ResourceRow[];
  assignments: AssignmentRow[];
  calendar: WorkCalendar;
}

export async function loadPlanningData(projectId: number): Promise<PlanningData> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw notFound('Projekt nicht gefunden');

  const [taskRows, edgeRows, resourceRows, assignmentRows, holidayRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(tasks.id),
    db.select().from(taskDependencies).where(eq(taskDependencies.projectId, projectId)),
    db.select().from(resources).where(eq(resources.projectId, projectId)),
    db
      .select({
        id: assignments.id,
        taskId: assignments.taskId,
        resourceId: assignments.resourceId,
        allocationPercent: assignments.allocationPercent,
        plannedStart: assignments.plannedStart,
        plannedEnd: assignments.plannedEnd,
        version: assignments.version,
        createdAt: assignments.createdAt,
        updatedAt: assignments.updatedAt,
      })
      .from(assignments)
      .innerJoin(tasks, eq(tasks.id, assignments.taskId))
      .where(eq(tasks.projectId, projectId)),
    db.select({ date: holidays.date }).from(holidays).where(eq(holidays.projectId, projectId)),
  ]);

  const calendar = new WorkCalendar({
    timezone: project.timezone,
    workweek: project.workweek,
    workdayStart: project.workdayStart,
    workdayEnd: project.workdayEnd,
    holidays: new Set(holidayRows.map((h) => h.date)),
  });

  return {
    project,
    tasks: taskRows,
    edges: edgeRows as DepEdge[],
    resources: resourceRows,
    assignments: assignmentRows,
    calendar,
  };
}
