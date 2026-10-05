import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { closeDatabase } from '../../db/client.js';
import { buildCanonicalString } from '../../http/sshAuth.js';
import { createUser, loginAgent } from './helpers.js';

/**
 * Externe SSH-API: Key-Verwaltung per Admin-API, signierte Requests,
 * Replay-/Ablauf-/Signaturfehler, Zyklusprüfung und Zuteilungen.
 */
const app = createApp();
const admin = await createUser({ role: 'admin' });
const agent = await loginAgent(app, admin);

afterAll(async () => {
  await closeDatabase();
});

// ---------------------------------------------------------------------------
// Hilfen: Schlüssel erzeugen & Requests signieren
// ---------------------------------------------------------------------------

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function toOpenSshEd25519(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const blob = Buffer.concat([
    sshString(Buffer.from('ssh-ed25519')),
    sshString(Buffer.from(jwk.x!, 'base64url')),
  ]);
  return `ssh-ed25519 ${blob.toString('base64')} integration@test`;
}

function makeKeyPair() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKeyLine: toOpenSshEd25519(pair.publicKey) };
}

function signHeaders(options: {
  keyId: number;
  privateKey: KeyObject;
  method: string;
  url: string;
  body: string;
  timestamp?: number;
}): Record<string, string> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const canonical = buildCanonicalString({
    keyId: options.keyId,
    timestamp,
    method: options.method,
    url: options.url,
    bodyHashHex: createHash('sha256').update(options.body).digest('hex'),
  });
  const signature = cryptoSign(null, Buffer.from(canonical, 'utf8'), options.privateKey);
  return {
    'x-pp-key-id': String(options.keyId),
    'x-pp-timestamp': String(timestamp),
    'x-pp-signature': signature.toString('base64'),
    'Content-Type': 'application/json',
  };
}

/** Sendet den Body als exakten String, damit die Signatur übereinstimmt. */
function externalPost(
  app: Express,
  url: string,
  body: unknown,
  opts: { keyId: number; privateKey: KeyObject; timestamp?: number; signatureOverride?: string },
) {
  const bodyString = JSON.stringify(body);
  const headers = signHeaders({
    keyId: opts.keyId,
    privateKey: opts.privateKey,
    method: 'POST',
    url,
    body: bodyString,
    timestamp: opts.timestamp,
  });
  if (opts.signatureOverride !== undefined) headers['x-pp-signature'] = opts.signatureOverride;
  return request(app).post(url).set(headers).send(bodyString);
}

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

async function createApiKey(projectId: number, publicKeyLine: string, extras: Record<string, unknown> = {}) {
  const res = await agent
    .post(`/api/v1/projects/${projectId}/api-keys`)
    .send({ name: 'Testschlüssel', publicKey: publicKeyLine, ...extras })
    .expect(201);
  return res.body.apiKey as {
    id: number;
    keyType: string;
    fingerprint: string;
    lastUsedAt: string | null;
    [key: string]: unknown;
  };
}

const projectId = await createProject('Externe-API-Projekt');
const key = makeKeyPair();
const apiKey = await createApiKey(projectId, key.publicKeyLine);

describe('Verwaltung von API-Schlüsseln', () => {
  it('legt einen Schlüssel an und liefert sichere Metadaten', async () => {
    expect(apiKey.keyType).toBe('ssh-ed25519');
    expect(apiKey.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(apiKey).not.toHaveProperty('publicKey');
    expect(apiKey.lastUsedAt).toBeNull();

    const list = await agent.get(`/api/v1/projects/${projectId}/api-keys`).expect(200);
    expect(list.body.items.map((k: { id: number }) => k.id)).toContain(apiKey.id);
  });

  it('lehnt ungültige Public Keys mit 422 ab', async () => {
    const res = await agent
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ name: 'Kaputt', publicKey: 'not-a-key' })
      .expect(422);
    expect(res.body.errors[0].path).toBe('publicKey');
  });

  it('deaktiviert, reaktiviert und löscht einen Schlüssel', async () => {
    const temp = makeKeyPair();
    const created = await createApiKey(projectId, temp.publicKeyLine, { name: 'Temporär' });

    const patched = await agent
      .patch(`/api/v1/api-keys/${created.id}`)
      .send({ isActive: false })
      .expect(200);
    expect(patched.body.apiKey.isActive).toBe(false);

    await agent.delete(`/api/v1/api-keys/${created.id}`).expect(204);
  });
});

describe('Signierte externe Requests', () => {
  it('legt Aufgaben und Unteraufgaben an (201, createdBy null)', async () => {
    const url = `/api/v1/external/projects/${projectId}/tasks`;
    const res = await externalPost(app, url, { name: 'Extern Haupt', estimatedMinutes: 120 }, {
      keyId: apiKey.id,
      privateKey: key.privateKey,
    }).expect(201);
    expect(res.body.task.name).toBe('Extern Haupt');
    expect(res.body.task.createdBy).toBeNull();

    const child = await externalPost(app, url, { name: 'Extern Kind', parentId: res.body.task.id }, {
      keyId: apiKey.id,
      privateKey: key.privateKey,
    }).expect(201);
    expect(child.body.task.parentId).toBe(res.body.task.id);
  });

  it('aktualisiert lastUsedAt nach erfolgreicher Nutzung', async () => {
    const list = await agent.get(`/api/v1/projects/${projectId}/api-keys`).expect(200);
    const used = list.body.items.find((k: { id: number }) => k.id === apiKey.id);
    expect(used.lastUsedAt).not.toBeNull();
  });

  it('fehlende Header → 401', async () => {
    const res = await request(app)
      .post(`/api/v1/external/projects/${projectId}/tasks`)
      .send({ name: 'Ohne Signatur' })
      .expect(401);
    expect(res.body.type).toBe('urn:projectplaner:unauthorized');
  });

  it('falsche Signatur → 401', async () => {
    const other = makeKeyPair();
    const wrong = cryptoSign(
      null,
      Buffer.from('falsch', 'utf8'),
      other.privateKey,
    ).toString('base64');
    await externalPost(
      app,
      `/api/v1/external/projects/${projectId}/tasks`,
      { name: 'Falsch signiert' },
      { keyId: apiKey.id, privateKey: key.privateKey, signatureOverride: wrong },
    ).expect(401);
  });

  it('abgelaufener Schlüssel → 401', async () => {
    const expiredKey = makeKeyPair();
    const created = await createApiKey(projectId, expiredKey.publicKeyLine, {
      name: 'Abgelaufen',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await externalPost(
      app,
      `/api/v1/external/projects/${projectId}/tasks`,
      { name: 'Zu spät' },
      { keyId: created.id, privateKey: expiredKey.privateKey },
    ).expect(401);
    expect(res.body.detail).toContain('abgelaufen');
  });

  it('deaktivierter Schlüssel → 401', async () => {
    const inactiveKey = makeKeyPair();
    const created = await createApiKey(projectId, inactiveKey.publicKeyLine, { name: 'Inaktiv' });
    await agent.patch(`/api/v1/api-keys/${created.id}`).send({ isActive: false }).expect(200);
    await externalPost(
      app,
      `/api/v1/external/projects/${projectId}/tasks`,
      { name: 'Deaktiviert' },
      { keyId: created.id, privateKey: inactiveKey.privateKey },
    ).expect(401);
  });

  it('alter Timestamp (Replay) → 401', async () => {
    const res = await externalPost(
      app,
      `/api/v1/external/projects/${projectId}/tasks`,
      { name: 'Replay' },
      {
        keyId: apiKey.id,
        privateKey: key.privateKey,
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      },
    ).expect(401);
    expect(res.body.detail).toContain('Timestamp');
  });

  it('Schlüssel eines anderen Projekts → 403', async () => {
    const otherProject = await createProject('Anderes Projekt');
    const res = await externalPost(
      app,
      `/api/v1/external/projects/${otherProject}/tasks`,
      { name: 'Fremd' },
      { keyId: apiKey.id, privateKey: key.privateKey },
    ).expect(403);
    expect(res.body.type).toBe('urn:projectplaner:forbidden');
  });
});

describe('Externe Abhängigkeiten und Zuteilungen', () => {
  it('legt eine Abhängigkeit an und lehnt einen Zyklus mit 400 ab', async () => {
    const url = `/api/v1/external/projects/${projectId}/tasks`;
    const a = (
      await externalPost(app, url, { name: 'Zyklus A', estimatedMinutes: 60 }, {
        keyId: apiKey.id,
        privateKey: key.privateKey,
      }).expect(201)
    ).body.task;
    const b = (
      await externalPost(app, url, { name: 'Zyklus B', estimatedMinutes: 60 }, {
        keyId: apiKey.id,
        privateKey: key.privateKey,
      }).expect(201)
    ).body.task;

    const depUrl = `/api/v1/external/projects/${projectId}/dependencies`;
    const created = await externalPost(app, depUrl, { predecessorId: a.id, successorId: b.id }, {
      keyId: apiKey.id,
      privateKey: key.privateKey,
    }).expect(201);
    expect(created.body.dependency.predecessorId).toBe(a.id);
    expect(created.body.dependency.successorId).toBe(b.id);

    const cycle = await externalPost(app, depUrl, { predecessorId: b.id, successorId: a.id }, {
      keyId: apiKey.id,
      privateKey: key.privateKey,
    }).expect(400);
    expect(cycle.body.type).toBe('urn:projectplaner:bad-request');
  });

  it('teilt eine Ressource zu (201) und erkennt Duplikate (409)', async () => {
    const taskRes = await externalPost(
      app,
      `/api/v1/external/projects/${projectId}/tasks`,
      { name: 'Zuteilung', estimatedMinutes: 60 },
      { keyId: apiKey.id, privateKey: key.privateKey },
    ).expect(201);
    const taskId = taskRes.body.task.id;

    const resourceRes = await agent
      .post(`/api/v1/projects/${projectId}/resources`)
      .send({ name: 'Externe Ressource', type: 'person' })
      .expect(201);
    const resourceId = resourceRes.body.resource.id;

    const url = `/api/v1/external/projects/${projectId}/tasks/${taskId}/assignments`;
    const created = await externalPost(app, url, { resourceId, allocationPercent: 50 }, {
      keyId: apiKey.id,
      privateKey: key.privateKey,
    }).expect(201);
    expect(created.body.assignment.resourceId).toBe(resourceId);
    expect(created.body.assignment.allocationPercent).toBe(50);

    await externalPost(app, url, { resourceId, allocationPercent: 50 }, {
      keyId: apiKey.id,
      privateKey: key.privateKey,
    }).expect(409);
  });
});
