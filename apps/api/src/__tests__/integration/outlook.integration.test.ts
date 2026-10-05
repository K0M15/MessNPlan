import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';

/**
 * Regressionstests für den Outlook-OAuth-Callback.
 *
 * Die Route muss VOR dem Auth-Gate liegen: Microsoft leitet cross-site zurück,
 * dabei werden SameSite=Strict-Cookies (unser Access-Token) nicht gesendet.
 * Der frühere Aufbau (requireAuth vor dem Callback) lieferte hier 401 statt
 * des Redirects zurück in die App.
 */
const app = createApp();

afterAll(async () => {
  await closeDatabase();
});

describe('Outlook-OAuth-Callback', () => {
  it('ist ohne Session erreichbar und leitet Fehler in die App (302 statt 401)', async () => {
    const res = await request(app).get(
      '/api/v1/integrations/outlook/callback?error=access_denied',
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'http://localhost:5173/?outlook=error&reason=access_denied',
    );
  });

  it('antwortet auf fehlende oder ungültige Parameter mit einem Redirect (invalid_state)', async () => {
    const missing = await request(app).get('/api/v1/integrations/outlook/callback');
    expect(missing.status).toBe(302);
    expect(missing.headers.location).toContain('outlook=error');

    const invalid = await request(app).get(
      '/api/v1/integrations/outlook/callback?code=irgendwas&state=ungueltig',
    );
    expect(invalid.status).toBe(302);
    expect(invalid.headers.location).toContain('reason=invalid_state');
  });

  it('lässt die übrigen Outlook-Routen hinter dem Auth-Gate', async () => {
    await request(app).get('/api/v1/integrations/outlook/connect').expect(401);
    await request(app).get('/api/v1/projects/1/outlook/connections').expect(401);
    await request(app)
      .patch('/api/v1/integrations/outlook/connections/1')
      .send({ syncEnabled: true })
      .expect(401);
  });
});
