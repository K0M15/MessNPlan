import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { TEST_PASSWORD, createUser, loginAgent, uniqueEmail } from './helpers.js';

/**
 * Testfall c): RBAC / Projektzugriff.
 * - Kein Mitglied → 404 auf Projekt-GET (Existenz wird nicht geleakt).
 * - Viewer-Mitglied → Lesen erlaubt, Schreiben (Task-PATCH) verboten (403).
 */
const app = createApp();
const admin = await createUser({ role: 'admin' });

afterAll(async () => {
  await closeDatabase();
});

describe('RBAC', () => {
  it('Nicht-Mitglied erhält 404, Viewer darf lesen aber nicht schreiben', async () => {
    const adminAgent = await loginAgent(app, admin);

    const projectRes = await adminAgent
      .post('/api/v1/projects')
      .send({
        name: 'RBAC-Projekt',
        timezone: 'UTC',
        workweek: [1, 2, 3, 4, 5],
        workdayStart: '08:00',
        workdayEnd: '16:00',
      })
      .expect(201);
    const projectId = projectRes.body.project.id as number;
    expect(projectRes.body.project.myRole).toBe('planner');

    // Zweiter Nutzer wird über die Admin-API angelegt (Rolle member).
    const memberEmail = uniqueEmail('rbac-member');
    const createdUser = await adminAgent
      .post('/api/v1/users')
      .send({ email: memberEmail, name: 'RBAC Member', password: TEST_PASSWORD, role: 'member' })
      .expect(201);
    const memberId = createdUser.body.user.id as number;
    expect(createdUser.body.user.role).toBe('member');

    const memberAgent = await loginAgent(app, {
      id: memberId,
      email: memberEmail,
      password: TEST_PASSWORD,
    });

    // Ohne Projektmitgliedschaft: 404 statt 403.
    await memberAgent.get(`/api/v1/projects/${projectId}`).expect(404);

    // Aufgabe durch den Admin anlegen (Projekt-Admin ist automatisch planner).
    const taskRes = await adminAgent
      .post(`/api/v1/projects/${projectId}/tasks`)
      .send({ name: 'RBAC-Aufgabe', estimatedMinutes: 60 })
      .expect(201);
    const taskId = taskRes.body.task.id as number;

    // Als Viewer aufnehmen.
    await adminAgent
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: memberId, role: 'viewer' })
      .expect(201);

    const readRes = await memberAgent.get(`/api/v1/projects/${projectId}`).expect(200);
    expect(readRes.body.project.myRole).toBe('viewer');

    // Viewer darf lesen, aber keine Aufgaben ändern.
    await memberAgent.get(`/api/v1/tasks/${taskId}`).expect(200);
    const forbidden = await memberAgent
      .patch(`/api/v1/tasks/${taskId}`)
      .send({ name: 'Vom Viewer geändert' })
      .expect(403);
    expect(forbidden.body.type).toBe('urn:projectplaner:forbidden');
  });
});
