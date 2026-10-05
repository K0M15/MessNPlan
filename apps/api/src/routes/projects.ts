import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import {
  holidayCreateSchema,
  projectCreateSchema,
  projectDeleteSchema,
  projectMemberSchema,
  projectUpdateSchema,
  REALTIME_EVENTS,
  type ProjectRole,
} from '@projectplaner/shared';
import { db } from '../db/client.js';
import { holidays, projectMembers, projects, users } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAuth, requireRole } from '../http/auth.js';
import { parse, parseId, parseIfMatch } from '../http/parse.js';
import { broadcastToProject } from '../realtime.js';
import { ensureProjectAccess, getProjectRole } from '../services/access.js';
import { writeAudit } from '../services/audit.js';
import { enqueueJob } from '../services/outbox.js';

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Normalisiert "HH:MM" → "HH:MM:SS". */
function normalizeTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

export function projectRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const user = req.user!;
    const rows =
      user.role === 'admin'
        ? await db.select().from(projects).orderBy(projects.name)
        : await db
            .select({
              project: projects,
              memberRole: projectMembers.role,
            })
            .from(projects)
            .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
            .where(eq(projectMembers.userId, user.id))
            .orderBy(projects.name);

    const items = rows.map((row) => {
      if ('project' in row) {
        return { ...row.project, myRole: row.memberRole as ProjectRole | 'admin' };
      }
      return { ...row, myRole: 'admin' as const };
    });
    res.json({ items });
  });

  router.post('/', requireRole('admin', 'planner'), async (req, res) => {
    const input = parse(projectCreateSchema, req.body);
    if (input.workdayStart >= input.workdayEnd) {
      throw badRequest('Arbeitsbeginn muss vor Arbeitsende liegen');
    }

    const [created] = await db
      .insert(projects)
      .values({
        name: input.name,
        description: input.description ?? null,
        timezone: input.timezone,
        workweek: input.workweek,
        workdayStart: normalizeTime(input.workdayStart),
        workdayEnd: normalizeTime(input.workdayEnd),
        scheduleAnchor: input.scheduleAnchor ? toDateOnly(input.scheduleAnchor) : null,
        status: input.status,
        createdBy: req.user!.id,
      })
      .$returningId();

    await db
      .insert(projectMembers)
      .values({ projectId: created!.id, userId: req.user!.id, role: 'planner' });

    const [project] = await db.select().from(projects).where(eq(projects.id, created!.id)).limit(1);
    await writeAudit({
      userId: req.user!.id,
      entityType: 'project',
      entityId: created!.id,
      action: 'create',
    });
    res.status(201).json({ project: { ...project!, myRole: 'planner' } });
  });

  router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const project = await ensureProjectAccess(id, req.user!);
    const role = await getProjectRole(id, req.user!);

    const members = await db
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, id));

    res.json({ project: { ...project, myRole: role }, members });
  });

  router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await ensureProjectAccess(id, req.user!, 'planner');
    const input = parse(projectUpdateSchema, req.body);

    // Effektive Werte prüfen, auch wenn nur ein Feld gesendet wird.
    const effectiveStart = normalizeTime(input.workdayStart ?? existing.workdayStart);
    const effectiveEnd = normalizeTime(input.workdayEnd ?? existing.workdayEnd);
    if (effectiveStart >= effectiveEnd) {
      throw badRequest('Arbeitsbeginn muss vor Arbeitsende liegen');
    }

    const updates: Partial<typeof projects.$inferInsert> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description ?? null;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.workweek !== undefined) updates.workweek = input.workweek;
    if (input.workdayStart !== undefined) updates.workdayStart = normalizeTime(input.workdayStart);
    if (input.workdayEnd !== undefined) updates.workdayEnd = normalizeTime(input.workdayEnd);
    if (input.scheduleAnchor !== undefined)
      updates.scheduleAnchor = input.scheduleAnchor ? toDateOnly(input.scheduleAnchor) : null;
    if (input.status !== undefined) updates.status = input.status;

    const expectedVersion = parseIfMatch(req);
    if (expectedVersion !== null) {
      const [result] = await db
        .update(projects)
        .set({ ...updates, version: sql`version + 1` })
        .where(and(eq(projects.id, id), eq(projects.version, expectedVersion)));
      if (result.affectedRows === 0) {
        throw conflict('Projekt wurde zwischenzeitlich geändert. Bitte neu laden.');
      }
    } else {
      await db
        .update(projects)
        .set({ ...updates, version: sql`version + 1` })
        .where(eq(projects.id, id));
    }

    // Kalender-/Anker-Änderungen erfordern eine Neuberechnung.
    const calendarChanged = (
      ['timezone', 'workweek', 'workdayStart', 'workdayEnd', 'scheduleAnchor'] as const
    ).some((key) => input[key] !== undefined);
    if (calendarChanged) {
      await enqueueJob('schedule.compute', { projectId: id, reason: 'project.calendar-changed' });
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    await writeAudit({
      userId: req.user!.id,
      entityType: 'project',
      entityId: id,
      action: 'update',
      diff: input as Record<string, unknown>,
    });
    broadcastToProject(id, REALTIME_EVENTS.PROJECT_CHANGED, { projectId: id });
    res.json({ project: { ...project!, myRole: await getProjectRole(id, req.user!) } });
  });

  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const project = await ensureProjectAccess(id, req.user!, 'planner');
    const input = parse(projectDeleteSchema, req.body);

    // Schutz vor versehentlichem Löschen: exakte Namensbestätigung.
    if (input.name.trim() !== project.name.trim()) {
      throw badRequest('Projektname stimmt nicht überein');
    }

    await db.delete(projects).where(eq(projects.id, id));
    await writeAudit({
      userId: req.user!.id,
      entityType: 'project',
      entityId: id,
      action: 'delete',
    });
    res.status(204).end();
  });

  // ---- Mitglieder -------------------------------------------------------

  router.get('/:id/members', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureProjectAccess(id, req.user!);
    const rows = await db
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, id));
    res.json({ items: rows });
  });

  router.post('/:id/members', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureProjectAccess(id, req.user!, 'planner');
    const input = parse(projectMemberSchema, req.body);

    const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user || !user.isActive) throw notFound('Benutzer nicht gefunden');

    await db
      .insert(projectMembers)
      .values({ projectId: id, userId: input.userId, role: input.role })
      .onDuplicateKeyUpdate({ set: { role: input.role } });

    res.status(201).json({
      member: { userId: user.id, name: user.name, email: user.email, role: input.role },
    });
  });

  router.delete('/:id/members/:userId', async (req, res) => {
    const id = parseId(req.params.id);
    const userId = parseId(req.params.userId, 'userId');
    await ensureProjectAccess(id, req.user!, 'planner');
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));
    res.status(204).end();
  });

  // ---- Feiertage --------------------------------------------------------

  router.get('/:id/holidays', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureProjectAccess(id, req.user!);
    const rows = await db
      .select()
      .from(holidays)
      .where(eq(holidays.projectId, id))
      .orderBy(holidays.date);
    res.json({ items: rows });
  });

  router.post('/:id/holidays', async (req, res) => {
    const id = parseId(req.params.id);
    await ensureProjectAccess(id, req.user!, 'planner');
    const input = parse(holidayCreateSchema, req.body);
    const date = toDateOnly(input.date);

    const [existing] = await db
      .select({ id: holidays.id })
      .from(holidays)
      .where(and(eq(holidays.projectId, id), eq(holidays.date, date)))
      .limit(1);
    if (existing) throw conflict('Für dieses Datum existiert bereits ein Feiertag');

    const [created] = await db
      .insert(holidays)
      .values({ projectId: id, date, name: input.name })
      .$returningId();
    await enqueueJob('schedule.compute', { projectId: id, reason: 'holiday.created' });
    const [row] = await db.select().from(holidays).where(eq(holidays.id, created!.id)).limit(1);
    res.status(201).json({ holiday: row });
  });

  router.delete('/:id/holidays/:holidayId', async (req, res) => {
    const id = parseId(req.params.id);
    const holidayId = parseId(req.params.holidayId, 'holidayId');
    await ensureProjectAccess(id, req.user!, 'planner');
    await db.delete(holidays).where(and(eq(holidays.id, holidayId), eq(holidays.projectId, id)));
    await enqueueJob('schedule.compute', { projectId: id, reason: 'holiday.deleted' });
    res.status(204).end();
  });

  return router;
}
