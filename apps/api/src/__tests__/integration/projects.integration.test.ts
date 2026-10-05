import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { createUser, loginAgent, type ApiAgent } from './helpers.js';

/**
 * Projekt löschen (Namensbestätigung + RBAC):
 * - falscher Name → 400, Projekt bleibt erhalten
 * - Admin löscht mit korrektem Namen → 204 und Cascade entfernt Inhalte
 * - Projekt-Planer (Projektrolle planner) darf löschen
 * - viewer/member ohne planner-Rolle → 403
 * - Projekt eines fremden Nutzers → 404 (kein Existenz-Leak)
 */
const app = createApp();
const admin = await createUser({ role: 'admin' });

afterAll(async () => {
  await closeDatabase();
});

async function createProject(agent: ApiAgent, name: string): Promise<number> {
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

describe('Projekt löschen', () => {
  it('falscher Projektname → 400 und Projekt bleibt erhalten', async () => {
    const adminAgent = await loginAgent(app, admin);
    const projectId = await createProject(adminAgent, 'Namensprüfung Projekt');

    const res = await adminAgent
      .delete(`/api/v1/projects/${projectId}`)
      .send({ name: 'Anderer Name' })
      .expect(400);
    expect(res.body.type).toBe('urn:projectplaner:bad-request');
    expect(res.body.detail).toBe('Projektname stimmt nicht überein');

    await adminAgent.get(`/api/v1/projects/${projectId}`).expect(200);
  });

  it('Admin löscht mit korrektem Namen → 204, Projekt und Aufgaben entfernt', async () => {
    const adminAgent = await loginAgent(app, admin);
    const projectId = await createProject(adminAgent, 'Admin-Löschprojekt');
    await adminAgent
      .post(`/api/v1/projects/${projectId}/tasks`)
      .send({ name: 'Wird mitgelöscht', estimatedMinutes: 60 })
      .expect(201);

    await adminAgent
      .delete(`/api/v1/projects/${projectId}`)
      .send({ name: 'Admin-Löschprojekt' })
      .expect(204);

    await adminAgent.get(`/api/v1/projects/${projectId}`).expect(404);
    await adminAgent.get(`/api/v1/projects/${projectId}/tasks`).expect(404);
  });

  it('Projekt-Planer (Projektrolle planner) darf löschen', async () => {
    const adminAgent = await loginAgent(app, admin);
    const projectId = await createProject(adminAgent, 'Planer-Löschprojekt');

    const planner = await createUser({ role: 'member' });
    await adminAgent
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: planner.id, role: 'planner' })
      .expect(201);

    const plannerAgent = await loginAgent(app, planner);
    await plannerAgent
      .delete(`/api/v1/projects/${projectId}`)
      .send({ name: 'Planer-Löschprojekt' })
      .expect(204);

    await plannerAgent.get(`/api/v1/projects/${projectId}`).expect(404);
  });

  it('Viewer und Member ohne planner-Rolle erhalten 403', async () => {
    const adminAgent = await loginAgent(app, admin);
    const projectId = await createProject(adminAgent, 'RBAC-Löschprojekt');

    for (const role of ['viewer', 'member'] as const) {
      const member = await createUser({ role: 'member' });
      await adminAgent
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: member.id, role })
        .expect(201);

      const memberAgent = await loginAgent(app, member);
      const res = await memberAgent
        .delete(`/api/v1/projects/${projectId}`)
        .send({ name: 'RBAC-Löschprojekt' })
        .expect(403);
      expect(res.body.type).toBe('urn:projectplaner:forbidden');
    }

    // Kein Löschen trotz korrektem Namen.
    await adminAgent.get(`/api/v1/projects/${projectId}`).expect(200);
  });

  it('Projekt eines anderen Nutzers → 404', async () => {
    const adminAgent = await loginAgent(app, admin);
    const projectId = await createProject(adminAgent, 'Fremdes Projekt');

    const stranger = await createUser({ role: 'planner' });
    const strangerAgent = await loginAgent(app, stranger);
    await strangerAgent
      .delete(`/api/v1/projects/${projectId}`)
      .send({ name: 'Fremdes Projekt' })
      .expect(404);

    await adminAgent.get(`/api/v1/projects/${projectId}`).expect(200);
  });
});
