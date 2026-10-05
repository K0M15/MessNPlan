import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { config } from '../config.js';
import { schema } from './schema.js';

const url = new URL(config.DATABASE_URL);

export const pool = mysql.createPool({
  host: url.hostname,
  port: url.port ? Number(url.port) : 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
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
