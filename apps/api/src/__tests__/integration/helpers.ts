import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import type * as supertest from 'supertest';
import { hashPassword } from '../../auth/passwords.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';

export type ApiAgent = supertest.Agent;

export const TEST_PASSWORD = 'integration-passwort-123';

export type Role = 'admin' | 'planner' | 'member' | 'viewer';

export interface TestUser {
  id: number;
  email: string;
  password: string;
}

let sequence = 0;

/** Eindeutige E-Mail pro Nutzer/Testlauf – keine Annahmen über Seed-Daten. */
export function uniqueEmail(prefix = 'user'): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${process.pid}-${sequence}-${randomUUID().slice(0, 8)}@test.local`;
}

/**
 * Legt einen Nutzer direkt in der Test-DB an. Nötig für den initialen Admin,
 * da `POST /users` selbst Admin-Rechte verlangt; weitere Nutzer werden in den
 * Tests über die Admin-API angelegt.
 */
export async function createUser(
  options: { role?: Role; password?: string; name?: string } = {},
): Promise<TestUser> {
  const email = uniqueEmail();
  const password = options.password ?? TEST_PASSWORD;
  const [created] = await db
    .insert(users)
    .values({
      email,
      name: options.name ?? 'Integration User',
      role: options.role ?? 'member',
      passwordHash: await hashPassword(password),
    })
    .$returningId();
  return { id: created!.id, email, password };
}

export interface AuthCookies {
  access: string;
  refresh: string;
}

function setCookieList(res: supertest.Response): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw as unknown as string];
}

export function cookieValue(res: supertest.Response, name: string): string {
  for (const cookie of setCookieList(res)) {
    const [pair = ''] = cookie.split(';');
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator) === name) {
      return pair.slice(separator + 1);
    }
  }
  throw new Error(`Cookie "${name}" nicht im Response gefunden`);
}

export function readAuthCookies(res: supertest.Response): AuthCookies {
  return { access: cookieValue(res, 'pp_at'), refresh: cookieValue(res, 'pp_rt') };
}

export function cookieHeader(cookies: Partial<AuthCookies>): string {
  const parts: string[] = [];
  if (cookies.access) parts.push(`pp_at=${cookies.access}`);
  if (cookies.refresh) parts.push(`pp_rt=${cookies.refresh}`);
  return parts.join('; ');
}

/** Login per API; liefert Access- und Refresh-Cookie. */
export async function login(app: Express, user: TestUser): Promise<AuthCookies> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);
  return readAuthCookies(res);
}

/** Login per API; behält Cookies automatisch für Folge-Requests (Session). */
export async function loginAgent(app: Express, user: TestUser): Promise<ApiAgent> {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);
  return agent;
}
