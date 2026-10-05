import fs from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { closeDatabase, db } from './client.js';

function findMigrationsFolder(): string {
  const candidates = [
    config.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'db/migrations'),
    path.resolve(process.cwd(), '../../db/migrations'),
    path.resolve(process.cwd(), 'apps/api/db/migrations'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }
  throw new Error(
    `Migrationsordner nicht gefunden. Kandidaten: ${candidates.join(', ')}. ` +
      'MIGRATIONS_DIR setzen oder aus dem Repo-Root ausführen.',
  );
}

async function main(): Promise<void> {
  const folder = findMigrationsFolder();
  logger.info({ folder }, 'Wende Datenbank-Migrationen an');
  await migrate(db, { migrationsFolder: folder });
  logger.info('Migrationen abgeschlossen');
  await closeDatabase();
}

main().catch((err) => {
  logger.error({ err }, 'Migration fehlgeschlagen');
  process.exitCode = 1;
});
