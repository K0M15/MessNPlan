import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { createUser, loginAgent } from './helpers.js';

/**
 * Testfälle d), e), f) und h):
 * - Aufgabenbaum + Move unter das eigene Kind → 400
 * - Abhängigkeiten: Zyklus und Oberaufgabe→Kind → 400
 * - Optimistic Locking für Task und Assignment (If-Match → 409/200)
 * - Validierung: ungültiges JSON und Arbeitszeitfenster
 */
const app = createApp();
const admin = await createUser({ role: 'admin' });
const agent = await loginAgent(app, admin);

afterAll(async () => {
  await closeDatabase();
});

async function createProject(name: string): Promise<number> {
  const res = await agent
    .post('/api/v1/projects')
    .send({
      name,
      timezone: 'UTC',
      workweek: [1, 2, 3, 4, 5],
      workdayStart: '08:00',
      workdayEnd: '16:00',
    })
    .expect(201);
  return res.body.project.id as number;
}

async function createTask(
  projectId: number,
  body: Record<string, unknown>,
): Promise<{ id: number; version: number; [key: string]: unknown }> {
  const res = await agent
    .post(`/api/v1/projects/${projectId}/tasks`)
    .send({ name: 'Aufgabe', ...body })
    .expect(201);
  return res.body.task;
}

describe('Task-Baum', () => {
  it('Move unter die eigene Teilaufgabe wird abgelehnt (400)', async () => {
    const projectId = await createProject('Taskbaum-Projekt');
    const parent = await createTask(projectId, { name: 'Eltern' });
    const child = await createTask(projectId, { name: 'Kind', parentId: parent.id });

    const res = await agent
      .post(`/api/v1/tasks/${parent.id}/move`)
      .send({ parentId: child.id })
      .expect(400);
    expect(res.body.type).toBe('urn:projectplaner:bad-request');

    // Baum bleibt unverändert.
    const tree = await agent.get(`/api/v1/projects/${projectId}/tasks?tree=1`).expect(200);
    expect(tree.body.items).toHaveLength(1);
    expect(tree.body.items[0].id).toBe(parent.id);
    expect(tree.body.items[0].children[0].id).toBe(child.id);
  });
});

describe('Abhängigkeiten', () => {
  it('Zyklus wird abgelehnt (400)', async () => {
    const projectId = await createProject('Abhängigkeits-Projekt');
    const a = await createTask(projectId, { name: 'A', estimatedMinutes: 60 });
    const b = await createTask(projectId, { name: 'B', estimatedMinutes: 60 });

    await agent
      .post(`/api/v1/tasks/${a.id}/dependencies`)
      .send({ predecessorId: a.id, successorId: b.id })
      .expect(201);

    const cyc = await agent
      .post(`/api/v1/tasks/${b.id}/dependencies`)
      .send({ predecessorId: b.id, successorId: a.id })
      .expect(400);
    expect(cyc.body.type).toBe('urn:projectplaner:bad-request');
  });

  it('Oberaufgabe als Vorgänger ihres eigenen Kindes wird abgelehnt (400)', async () => {
    const projectId = await createProject('Hierarchie-Projekt');
    const parent = await createTask(projectId, { name: 'Oberaufgabe' });
    const child = await createTask(projectId, { name: 'Teilaufgabe', parentId: parent.id });

    const res = await agent
      .post(`/api/v1/tasks/${parent.id}/dependencies`)
      .send({ predecessorId: parent.id, successorId: child.id })
      .expect(400);
    expect(res.body.type).toBe('urn:projectplaner:bad-request');
  });

  it('GET /tasks/:id/dependencies trennt Vorgänger und Nachfolger korrekt', async () => {
    const projectId = await createProject('Abhängigkeitsrichtung-Projekt');
    const pred = await createTask(projectId, { name: 'Vorgänger', estimatedMinutes: 60 });
    const succ = await createTask(projectId, { name: 'Nachfolger', estimatedMinutes: 60 });

    await agent
      .post(`/api/v1/tasks/${pred.id}/dependencies`)
      .send({ predecessorId: pred.id, successorId: succ.id })
      .expect(201);

    const fromPred = await agent.get(`/api/v1/tasks/${pred.id}/dependencies`).expect(200);
    expect(fromPred.body.predecessors).toHaveLength(0);
    expect(fromPred.body.successors).toHaveLength(1);
    expect(fromPred.body.successors[0].successorId).toBe(succ.id);

    const fromSucc = await agent.get(`/api/v1/tasks/${succ.id}/dependencies`).expect(200);
    expect(fromSucc.body.predecessors).toHaveLength(1);
    expect(fromSucc.body.predecessors[0].predecessorId).toBe(pred.id);
    expect(fromSucc.body.successors).toHaveLength(0);
  });
});

describe('Optimistic Locking', () => {
  it('Task-PATCH: falsche Version → 409, richtige Version → 200 und version+1', async () => {
    const projectId = await createProject('Locking-Projekt');
    const task = await createTask(projectId, { name: 'Locking', estimatedMinutes: 30 });

    await agent
      .patch(`/api/v1/tasks/${task.id}`)
      .set('If-Match', '9999')
      .send({ name: 'Konflikt' })
      .expect(409);

    const ok = await agent
      .patch(`/api/v1/tasks/${task.id}`)
      .set('If-Match', String(task.version))
      .send({ name: 'Aktualisiert' })
      .expect(200);
    expect(ok.body.task.version).toBe(task.version + 1);
    expect(ok.body.task.name).toBe('Aktualisiert');
  });

  it('Assignment-PATCH: falsche Version → 409, richtige Version → 200 und version+1', async () => {
    const projectId = await createProject('Assignment-Locking-Projekt');
    const task = await createTask(projectId, { name: 'Locking-Task', estimatedMinutes: 60 });

    const resourceRes = await agent
      .post(`/api/v1/projects/${projectId}/resources`)
      .send({ name: 'Anna Beispiel', type: 'person', capacityMinutesPerDay: 480 })
      .expect(201);
    const resourceId = resourceRes.body.resource.id as number;

    const assignmentRes = await agent
      .post(`/api/v1/tasks/${task.id}/assignments`)
      .send({ resourceId, allocationPercent: 50 })
      .expect(201);
    const assignment = assignmentRes.body.assignment as { id: number; version: number };

    await agent
      .patch(`/api/v1/assignments/${assignment.id}`)
      .set('If-Match', '4242')
      .send({ allocationPercent: 80 })
      .expect(409);

    const ok = await agent
      .patch(`/api/v1/assignments/${assignment.id}`)
      .set('If-Match', String(assignment.version))
      .send({ allocationPercent: 80 })
      .expect(200);
    expect(ok.body.assignment.version).toBe(assignment.version + 1);
    expect(ok.body.assignment.allocationPercent).toBe(80);
  });
});

describe('Validierung', () => {
  it('ungültiges JSON → 400', async () => {
    const res = await agent
      .post('/api/v1/projects')
      .set('Content-Type', 'application/json')
      .send('{"name": ')
      .expect(400);
    expect(res.body.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('PATCH mit workdayEnd vor workdayStart → 400', async () => {
    const projectId = await createProject('Validierungs-Projekt');
    const res = await agent
      .patch(`/api/v1/projects/${projectId}`)
      .send({ workdayEnd: '07:00' })
      .expect(400);
    expect(res.body.type).toBe('urn:projectplaner:bad-request');
  });
});
