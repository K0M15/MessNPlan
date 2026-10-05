import mysql, { type PoolOptions } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { config } from '../config.js';
import { schema } from './schema.js';

/**
 * Zugriffsdaten: Im Container werden DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
 * bevorzugt – so sind Sonderzeichen im Passwort unkritisch (kein URL-Encoding
 * nötig). Auf dem Host/Dev greift der Fallback auf DATABASE_URL.
 */
function connectionOptions(): PoolOptions {
  if (config.DB_HOST) {
    return {
      host: config.DB_HOST,
      port: config.DB_PORT ?? 3306,
      user: config.DB_USER ?? '',
      password: config.DB_PASSWORD ?? '',
      database: config.DB_NAME ?? '',
    };
  }

  const url = new URL(config.DATABASE_URL ?? '');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

export const pool = mysql.createPool({
  ...connectionOptions(),
  connectionLimit: config.DB_CONNECTION_LIMIT,
  timezone: 'Z',
  charset: 'utf8mb4',
  supportBigNumbers: true,
  enableKeepAlive: true,
});

export const db = drizzle(pool, { schema, mode: 'default' });

export type Db = typeof db;

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
