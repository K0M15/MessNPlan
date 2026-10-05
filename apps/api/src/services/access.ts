import { and, eq } from 'drizzle-orm';
import type { ProjectRole } from '@projectplaner/shared';
import { db } from '../db/client.js';
import { projectMembers, projects, tasks } from '../db/schema.js';
import { forbidden, notFound } from '../errors.js';
import type { AuthUser } from '../http/auth.js';

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, member: 2, planner: 3 };

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;

/** Prüft Projektzugriff; liefert das Projekt oder 404/403. */
export async function ensureProjectAccess(
  projectId: number,
  user: AuthUser,
  minRole: ProjectRole = 'viewer',
): Promise<ProjectRow> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw notFound('Projekt nicht gefunden');
  if (user.role === 'admin') return project;

  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
    .limit(1);

  if (!membership) throw notFound('Projekt nicht gefunden');
  if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
    throw forbidden(`Rolle "${minRole}" in diesem Projekt erforderlich`);
  }
  return project;
}

export type ProjectRoleOrAdmin = ProjectRole | 'admin';

/** Liefert die effektive Projektrolle des Nutzers oder null. */
export async function getProjectRole(
  projectId: number,
  user: AuthUser,
): Promise<ProjectRoleOrAdmin | null> {
  if (user.role === 'admin') return 'admin';
  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
    .limit(1);
  return membership?.role ?? null;
}

/** Prüft Schreibzugriff auf Projektinhalte (Aufgaben, Zuteilungen, Kommentare). */
export function ensureProjectWrite(projectId: number, user: AuthUser, minRole: ProjectRole = 'member') {
  return ensureProjectAccess(projectId, user, minRole);
}

/** Prüft Aufgaben-Zugriff und liefert Aufgabe + Projekt. */
export async function ensureTaskAccess(
  taskId: number,
  user: AuthUser,
  minRole: ProjectRole = 'viewer',
): Promise<{ task: TaskRow; project: ProjectRow }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw notFound('Aufgabe nicht gefunden');
  const project = await ensureProjectAccess(task.projectId, user, minRole);
  return { task, project };
}
