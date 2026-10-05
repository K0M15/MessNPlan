import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import type { ProvidedContext } from 'vitest';

/**
 * Vitest `globalSetup`: startet EINEN MySQL-Container für die gesamte Suite,
 * wendet die vorhandenen Drizzle-Migrationen an und reicht die DSN per
 * `provide('databaseUrl', …)` an die Test-Worker weiter (dort via `inject`
 * in setupEnv.ts gelesen).
 *
 * Hinweis: Der Ryuk-Reaper wird deaktiviert, weil das Image in dieser Umgebung
 * nicht lokal vorliegt; der Container wird im `teardown` explizit gestoppt.
 */
process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

const MYSQL_IMAGE = 'mysql:8.4';
const DATABASE = 'projectplaner_test';

let container: StartedMySqlContainer | undefined;

function findMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Repo-Root (Aufruf aus dem Root) …
    path.resolve(process.cwd(), 'db/migrations'),
    // … oder aus dem API-Workspace (npm run -w @projectplaner/api).
    path.resolve(process.cwd(), '../../db/migrations'),
    path.resolve(process.cwd(), 'apps/api/db/migrations'),
    // Fallback relativ zu dieser Datei (src/__tests__/integration → Repo-Root).
    path.resolve(here, '../../../../../db/migrations'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) return candidate;
  }
  throw new Error(`Migrationsordner nicht gefunden. Kandidaten: ${candidates.join(', ')}`);
}

function mysqlPoolFromUri(uri: string) {
  const parsed = new URL(uri);
  return mysql.createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    timezone: 'Z',
    charset: 'utf8mb4',
    connectionLimit: 5,
  });
}

interface GlobalSetupContext {
  provide: <T extends keyof ProvidedContext & string>(key: T, value: ProvidedContext[T]) => void;
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new MySqlContainer(MYSQL_IMAGE)
    .withDatabase(DATABASE)
    .withUsername('test')
    .withUserPassword('test')
    .start();

  const databaseUrl = container.getConnectionUri();
  const migrationsFolder = findMigrationsFolder();

  const pool = mysqlPoolFromUri(databaseUrl);
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }

  provide('databaseUrl', databaseUrl);
  console.warn(
    `[integration] MySQL ${MYSQL_IMAGE} bereit; Migrationen aus ${migrationsFolder} angewendet.`,
  );
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = undefined;
}
