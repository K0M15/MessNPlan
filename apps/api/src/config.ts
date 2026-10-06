import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// .env aus Repo-Root laden, egal aus welchem Workspace das Skript startet.
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3000),

    /** Host-/Dev-Zugriff; im Container werden stattdessen DB_* genutzt. */
    DATABASE_URL: z.string().min(1).optional(),
    DB_HOST: z.string().min(1).optional(),
    DB_PORT: z.coerce.number().int().positive().optional(),
    DB_USER: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_NAME: z.string().optional(),

  APP_ORIGIN: z.string().default('http://localhost:5173'),
  /** Kommaseparierte Liste zusätzlicher erlaubter Origins (z. B. Dev-Ports). */
  ALLOWED_ORIGINS: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen haben'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: boolFromEnv(false),

  APP_ENCRYPTION_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  GRAPH_CLIENT_ID: z.string().optional(),
  GRAPH_TENANT_ID: z.string().default('common'),
  GRAPH_CLIENT_SECRET: z.string().optional(),
  GRAPH_REDIRECT_URI: z.string().optional(),

  MIGRATIONS_DIR: z.string().optional(),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),
  /** Express "trust proxy": "false", "true", Zahl oder z. B. "loopback". Standard: 1 in Prod, sonst false. */
  TRUST_PROXY: z.string().optional(),
})
  .superRefine((value, ctx) => {
    const hasUrl = Boolean(value.DATABASE_URL);
    const hasParts = Boolean(value.DB_HOST && value.DB_NAME);
    if (!hasUrl && !hasParts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Entweder DATABASE_URL (Host/Zugriff) oder DB_HOST + DB_NAME (+ DB_USER/DB_PASSWORD) setzen',
        path: ['DATABASE_URL'],
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Ungültige Umgebungsvariablen:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
export const isTest = config.NODE_ENV === 'test';

export const trustProxy: boolean | number | string = (() => {
  const raw = config.TRUST_PROXY?.trim();
  if (!raw) return isProduction ? 1 : false;
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true') return 1;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
})();

export const allowedOrigins = [
  config.APP_ORIGIN,
  ...(config.ALLOWED_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
  ...(isDevelopment
    ? ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']
    : []),
];

const DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Erlaubt konfigurierte Origins; in Development zusätzlich jeden localhost-Port
 * (z. B. wenn Vite wegen belegter Ports auf 5174/5175 ausweicht).
 */
export function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;
  return isDevelopment && DEV_ORIGIN_PATTERN.test(origin);
}
