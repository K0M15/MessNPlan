import { afterAll, describe, expect, it } from 'vitest';
import { HEALTH_RULES } from '@projectplaner/shared';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { createUser, loginAgent, type ApiAgent } from './helpers.js';

/**
 * Ressourcen-Kalender: Wochentags-Arbeitszeiten + Abwesenheiten.
 *
 * Szenario: Projekt Mo–Fr 08:00–16:00 (UTC), Aufgabe 480 Min (→ Montag),
 * Ressource arbeitet montags nur 08:00–12:00 (240 Min Kapazität).
 * - ohne Abwesenheit → Überbelegung (480 > 240)
 * - mit Abwesenheit am Montag → Warnung „Zuteilung am Abwesenheitstag“,
 *   Kapazität im Gantt 0 (Belegung bleibt sichtbar)
 */
const app = createApp();
const admin = await createUser({ role: 'admin' });
const adminAgent = await loginAgent(app, admin);

const projectRes = await adminAgent
  .post('/api/v1/projects')
  .send({
    name: 'Abwesenheits-Projekt',
    timezone: 'UTC',
    workweek: [1, 2, 3, 4, 5],
    workdayStart: '08:00',
    workdayEnd: '16:00',
    scheduleAnchor: '2026-10-05',
  })
  .expect(201);
const projectId = projectRes.body.project.id as number;

const resourceRes = await adminAgent
  .post(`/api/v1/projects/${projectId}/resources`)
  .send({
    name: 'Teilzeit Montag',
    capacityMinutesPerDay: 480,
    workingHours: { '1': { start: '08:00', end: '12:00' } },
  })
  .expect(201);
const resourceId = resourceRes.body.resource.id as number;

const taskRes = await adminAgent
  .post(`/api/v1/projects/${projectId}/tasks`)
  .send({ name: 'Montagsaufgabe', estimatedMinutes: 480 })
  .expect(201);
const taskId = taskRes.body.task.id as number;

await adminAgent
  .post(`/api/v1/tasks/${taskId}/assignments`)
  .send({ resourceId, allocationPercent: 100 })
  .expect(201);

afterAll(async () => {
  await closeDatabase();
});

async function healthIssues(): Promise<Array<{ rule: string; resourceId?: number; details?: Record<string, unknown> }>> {
  const res = await adminAgent.get(`/api/v1/projects/${projectId}/health`).expect(200);
  return res.body.issues as Array<{ rule: string; resourceId?: number; details?: Record<string, unknown> }>;
}

describe('Abwesenheiten + Ressourcen-Arbeitszeiten', () => {
  it('meldet Überbelegung gegen die Ressourcen-Arbeitszeit (240 statt Projekt-480)', async () => {
    await adminAgent.post(`/api/v1/projects/${projectId}/schedule`).send({}).expect(200);
    const issues = await healthIssues();
    const overallocated = issues.find(
      (issue) => issue.rule === HEALTH_RULES.RESOURCE_OVERALLOCATED && issue.resourceId === resourceId,
    );
    expect(overallocated).toBeDefined();
    expect(overallocated!.details).toMatchObject({
      day: '2026-10-05',
      allocatedMinutes: 480,
      capacityMinutes: 240,
    });
    expect(issues.some((issue) => issue.rule === HEALTH_RULES.RESOURCE_ASSIGNED_ON_ABSENCE)).toBe(false);
  });

  it('Kapazitäts-Buckets im Gantt folgen der Ressourcen-Arbeitszeit', async () => {
    const res = await adminAgent.get(`/api/v1/projects/${projectId}/gantt`).expect(200);
    const bucket = (res.body.utilization.buckets as Array<Record<string, unknown>>).find(
      (entry) =>
        entry.resourceId === resourceId && entry.start === '2026-10-05T08:00:00.000Z',
    );
    expect(bucket).toBeDefined();
    expect(bucket).toMatchObject({ allocatedMinutes: 480, capacityMinutes: 240 });
  });

  it('legt Abwesenheiten an, listet sie und liefert sie im Gantt-Payload', async () => {
    const created = await adminAgent
      .post(`/api/v1/resources/${resourceId}/absences`)
      .send({ startDate: '2026-10-05', endDate: '2026-10-05', type: 'vacation', name: 'Urlaub' })
      .expect(201);
    expect(created.body.absence).toMatchObject({
      resourceId,
      startDate: '2026-10-05',
      endDate: '2026-10-05',
      type: 'vacation',
      name: 'Urlaub',
    });

    const list = await adminAgent.get(`/api/v1/resources/${resourceId}/absences`).expect(200);
    expect(list.body.items).toHaveLength(1);

    const gantt = await adminAgent.get(`/api/v1/projects/${projectId}/gantt`).expect(200);
    expect(gantt.body.absences).toEqual([
      expect.objectContaining({ resourceId, startDate: '2026-10-05', endDate: '2026-10-05' }),
    ]);

    // Abwesenheitstag: Kapazität 0, Belegung bleibt sichtbar.
    const bucket = (gantt.body.utilization.buckets as Array<Record<string, unknown>>).find(
      (entry) =>
        entry.resourceId === resourceId && entry.start === '2026-10-05T08:00:00.000Z',
    );
    expect(bucket).toMatchObject({ allocatedMinutes: 480, capacityMinutes: 0 });
  });

  it('warnt bei Zuteilung an einem Abwesenheitstag statt zu überbelegen', async () => {
    const issues = await healthIssues();
    const absenceIssue = issues.find(
      (issue) => issue.rule === HEALTH_RULES.RESOURCE_ASSIGNED_ON_ABSENCE && issue.resourceId === resourceId,
    );
    expect(absenceIssue).toBeDefined();
    expect(absenceIssue!.details).toMatchObject({ day: '2026-10-05', allocatedMinutes: 480 });
    expect(
      issues.some(
        (issue) => issue.rule === HEALTH_RULES.RESOURCE_OVERALLOCATED && issue.resourceId === resourceId,
      ),
    ).toBe(false);
  });

  it('validiert den Abwesenheitszeitraum (Ende vor Start → 422)', async () => {
    const res = await adminAgent
      .post(`/api/v1/resources/${resourceId}/absences`)
      .send({ startDate: '2026-10-09', endDate: '2026-10-05' })
      .expect(422);
    expect(res.body.type).toBe('urn:projectplaner:validation');
  });

  it('RBAC: Mitglieder dürfen lesen, aber nicht schreiben', async () => {
    const member = await createUser({ role: 'member' });
    await adminAgent
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: member.id, role: 'member' })
      .expect(201);
    const memberAgent: ApiAgent = await loginAgent(app, member);

    await memberAgent.get(`/api/v1/resources/${resourceId}/absences`).expect(200);
    await memberAgent
      .post(`/api/v1/resources/${resourceId}/absences`)
      .send({ startDate: '2026-10-06', endDate: '2026-10-06' })
      .expect(403);

    const list = await adminAgent.get(`/api/v1/resources/${resourceId}/absences`).expect(200);
    const absenceId = list.body.items[0].id as number;
    await memberAgent.delete(`/api/v1/absences/${absenceId}`).expect(403);
    await adminAgent.delete(`/api/v1/absences/${absenceId}`).expect(204);

    const after = await adminAgent.get(`/api/v1/resources/${resourceId}/absences`).expect(200);
    expect(after.body.items).toHaveLength(0);
  });
});
