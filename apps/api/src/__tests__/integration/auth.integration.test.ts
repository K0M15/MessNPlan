import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../../app.js';
import { closeDatabase, db } from '../../db/client.js';
import { cookieHeader, createUser, login, readAuthCookies } from './helpers.js';

/**
 * Testfälle a) + b): Auth-Flow, Refresh-Rotation und Familien-Widerruf bei
 * Refresh-Reuse – gegen die echte MySQL aus dem Testcontainer.
 *
 * Der initiale Nutzer wird direkt in der DB angelegt (kein Seed nötig);
 * alle Requests laufen über `createApp()` per Supertest.
 */
const app = createApp();
const user = await createUser({ role: 'member' });

afterAll(async () => {
  await closeDatabase();
});

describe('Auth-Flow', () => {
  it('Login mit korrekten Zugangsdaten liefert Auth-Cookies', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, role: 'member' });
    const cookies = readAuthCookies(res);
    expect(cookies.access).toBeTruthy();
    expect(cookies.refresh).toBeTruthy();
  });

  it('falsches Passwort → 401 (RFC-7807)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'definitiv-falsches-passwort' })
      .expect(401);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 401, type: 'urn:projectplaner:unauthorized' });
  });

  it('GET /auth/me liefert den angemeldeten Nutzer', async () => {
    const cookies = await login(app, user);
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader(cookies))
      .expect(200);

    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('Refresh rotiert den Refresh-Token; Logout widerruft den neuen Token', async () => {
    const before = await login(app, user);
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: before.refresh }))
      .expect(200);
    const after = readAuthCookies(refreshed);

    expect(after.refresh).not.toBe(before.refresh);
    expect(after.access).toBeTruthy();

    await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader(after))
      .expect(204);

    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: after.refresh }))
      .expect(401);
  });
});

describe('Refresh-Reuse', () => {
  it('behandelt Reuse im Grace-Fenster als Retry ohne Familien-Widerruf', async () => {
    const initial = await login(app, user);

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: initial.refresh }))
      .expect(200);
    const next = readAuthCookies(rotated);

    // Sofortiger zweiter Request mit dem alten Token (Multi-Tab-Race/Retry).
    const retry = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: initial.refresh }))
      .expect(200);
    const retryCookies = readAuthCookies(retry);
    expect(retryCookies.refresh).not.toBe(initial.refresh);
    expect(retryCookies.refresh).not.toBe(next.refresh);

    // Der zuvor ausgegebene Token bleibt gültig (keine Familien-Widerrufung).
    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: next.refresh }))
      .expect(200);
  });

  it('widerruft die gesamte Token-Familie bei echtem Reuse außerhalb des Fensters', async () => {
    const initial = await login(app, user);

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: initial.refresh }))
      .expect(200);
    const next = readAuthCookies(rotated);
    expect(next.refresh).not.toBe(initial.refresh);

    // Grace-Fenster simulieren: Widerrufszeitpunkt künstlich altern.
    await db.execute(sql`
      UPDATE refresh_tokens
      SET revoked_at = DATE_SUB(revoked_at, INTERVAL 60 SECOND)
      WHERE user_id = ${user.id} AND revoked_at IS NOT NULL
    `);

    // Reuse des alten Tokens → 401 und Familien-Widerruf.
    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: initial.refresh }))
      .expect(401);

    // Der zuvor ausgegebene neue Token ist ebenfalls widerrufen.
    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ refresh: next.refresh }))
      .expect(401);
  });
});
