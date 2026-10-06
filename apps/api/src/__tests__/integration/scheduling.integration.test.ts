import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEALTH_RULES } from '@projectplaner/shared';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { createUser, loginAgent } from './helpers.js';

/**
 * Testfall g): Scheduling-Persistenz + Health.
 * Summary + zwei Kinder (je Schätzung) + FS-Nachfolger auf die Summary.
 * Erwartung: Summary = Rollup der Kinder; Nachfolger startet nach dem
 * Summary-Ende (nicht am Anker).
 */
const app = createApp();
const admin = await createUser({ role: 'admin' });
const agent = await loginAgent(app, admin);

const projectRes = await agent
  .post('/api/v1/projects')
  .send({
    name: 'Scheduling-Projekt',
    timezone: 'UTC',
    workweek: [1, 2, 3, 4, 5],
    workdayStart: '08:00',
    workdayEnd: '16:00',
    scheduleAnchor: '2026-10-05',
  })
  .expect(201);
const projectId = projectRes.body.project.id as number;

async function createTask(body: Record<string, unknown>): Promise<{ id: number }> {
  const res = await agent
    .post(`/api/v1/projects/${projectId}/tasks`)
    .send({ name: 'Aufgabe', ...body })
    .expect(201);
  return res.body.task;
}

const summary = await createTask({ name: 'Summary' });
const childA = await createTask({ name: 'Kind A', parentId: summary.id, estimatedMinutes: 480 });
const childB = await createTask({ name: 'Kind B', parentId: summary.id, estimatedMinutes: 960 });
const successor = await createTask({ name: 'Nachfolger', estimatedMinutes: 240 });

await agent
  .post(`/api/v1/tasks/${summary.id}/dependencies`)
  .send({ predecessorId: summary.id, successorId: successor.id })
  .expect(201);

afterAll(async () => {
  await closeDatabase();
});

describe('Scheduling', () => {
  beforeAll(async () => {
    const res = await agent.post(`/api/v1/projects/${projectId}/schedule`).send({}).expect(200);
    expect(res.body.result).toMatchObject({ projectId, taskCount: 4, cyclicCount: 0 });
  });

  it('Summary-Zeitraum ist der Rollup der Kinder, Nachfolger startet danach', async () => {
    const res = await agent.get(`/api/v1/projects/${projectId}/schedule`).expect(200);
    const byId = new Map<number, Record<string, unknown>>(
      (res.body.tasks as Array<Record<string, unknown>>).map((task) => [task.id as number, task]),
    );

    const s = byId.get(summary.id)!;
    const a = byId.get(childA.id)!;
    const b = byId.get(childB.id)!;
    const n = byId.get(successor.id)!;

    // Anker: Montag 2026-10-05 08:00 UTC.
    expect(a.plannedStart).toBe('2026-10-05T08:00:00.000Z');

    // Summary-Rollup: min(Start der Kinder) bis max(Ende der Kinder).
    expect(s.plannedStart).toBe(a.plannedStart);
    expect(s.plannedEnd).toBe(b.plannedEnd);
    expect(new Date(b.plannedEnd as string).getTime()).toBeGreaterThan(
      new Date(a.plannedEnd as string).getTime(),
    );

    // FS-Nachfolger auf die Summary: startet an deren Ende, nicht am Anker.
    expect(n.plannedStart).toBe(s.plannedEnd);
    expect(new Date(n.plannedStart as string).getTime()).toBeGreaterThan(
      new Date(s.plannedStart as string).getTime(),
    );
  });
});

describe('Health', () => {
  it('liefert Issues und Summary', async () => {
    const res = await agent.get(`/api/v1/projects/${projectId}/health`).expect(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.summary).toMatchObject({
      error: expect.any(Number),
      warning: expect.any(Number),
      info: expect.any(Number),
      total: expect.any(Number),
    });
    expect(res.body.summary.total).toBe(res.body.issues.length);

    const rules = (res.body.issues as Array<{ rule: string }>).map((issue) => issue.rule);
    expect(rules).not.toContain(HEALTH_RULES.DEPENDENCY_CYCLE);
  });
});

describe('Schlanker Gantt-Payload, ETag und Auslastung', () => {
  it('liefert nur berechnete Task-Felder, Kanten und Abwesenheiten (keine Utilization)', async () => {
    const res = await agent.get(`/api/v1/projects/${projectId}/gantt`).expect(200);

    expect(res.body).not.toHaveProperty('utilization');
    expect(res.body).toHaveProperty('absences');
    expect(Array.isArray(res.body.tasks)).toBe(true);
    const first = res.body.tasks[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(['critical', 'id', 'slackMinutes']);
    expect(res.body.edges.length).toBeGreaterThan(0);
    expect(res.headers.etag).toBeTruthy();
  });

  it('antwortet mit 304, wenn die Planversion unverändert ist', async () => {
    const first = await agent.get(`/api/v1/projects/${projectId}/gantt`).expect(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    await agent.get(`/api/v1/projects/${projectId}/gantt`).set('If-None-Match', etag).expect(304);

    // Nach Neuberechnung ändert sich das ETag.
    await agent.post(`/api/v1/projects/${projectId}/schedule`).send({}).expect(200);
    const after = await agent.get(`/api/v1/projects/${projectId}/gantt`).expect(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  it('liefert die Auslastung separat; Kapazitätsdaten enden nahe dem letzten Plantag', async () => {
    const res = await agent.get(`/api/v1/projects/${projectId}/utilisation`).expect(200);
    expect(res.body.bucketMinutes).toBeGreaterThan(0);
    expect(Array.isArray(res.body.buckets)).toBe(true);

    const from = new Date(res.body.from as string);
    const to = new Date(res.body.to as string);
    // Anker 2026-10-05: Achse beginnt davor.
    expect(from.getTime()).toBeLessThanOrEqual(new Date('2026-10-05T00:00:00Z').getTime());
    // Kapazitätsdaten werden auf ~90 Tage nach dem letzten Planende begrenzt
    // (die 5-Jahres-Achse selbst rendert der Client).
    const schedule = await agent.get(`/api/v1/projects/${projectId}/schedule`).expect(200);
    const plannedEnds = (schedule.body.tasks as Array<{ plannedEnd: string | null }>)
      .map((task) => task.plannedEnd)
      .filter((value): value is string => value !== null)
      .map((value) => new Date(value).getTime());
    const lastEnd = Math.max(...plannedEnds);
    expect(to.getTime()).toBeGreaterThanOrEqual(lastEnd);

    // Expliziter Zoom-Bereich wird respektiert (Tages-Buckets über 3 Tage).
    const ranged = await agent
      .get(
        `/api/v1/projects/${projectId}/utilisation?from=2026-10-05T00:00:00.000Z&to=2026-10-08T00:00:00.000Z&bucketMinutes=1440`,
      )
      .expect(200);
    expect(ranged.body.bucketMinutes).toBe(1440);
    expect(ranged.body.to).toBe('2026-10-08T00:00:00.000Z');
  });
});
