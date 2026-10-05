import { z } from 'zod';

/**
 * Konfiguration des MCP-Servers – vollständig aus Umgebungsvariablen.
 *
 * Zwei Zugriffswege auf die REST-API:
 * - `rest`: Service-Login mit `PP_EMAIL`/`PP_PASSWORD` (Cookie-Session).
 * - `ssh`:  SSH-signierte externe API mit `PP_KEY_ID`/`PP_PRIVATE_KEY_PATH`
 *           (nur Mutationen; Lesen ist damit nicht möglich).
 */
export const AUTH_MODES = ['rest', 'ssh'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const KEY_TYPES = ['ssh-ed25519', 'ssh-rsa'] as const;
export type SshKeyType = (typeof KEY_TYPES)[number];

export interface McpConfig {
  apiUrl: string;
  authMode: AuthMode;
  /** REST-Service-Login. */
  email?: string;
  password?: string;
  /** SSH-signierte externe API. */
  keyId?: number;
  keyType?: SshKeyType;
  privateKeyPath?: string;
  /** Optional: Projektbindung des SSH-Schlüssels (Frühprüfung). */
  projectId?: number;
  /** Interner Verify-Endpunkt der API (HTTP-Transport). */
  internalUrl?: string;
  internalToken?: string;
  /** Streamable-HTTP-Transport. */
  host: string;
  port: number;
}

/** `""` aus Compose-/Shell-Env gilt als „nicht gesetzt". */
const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' || value === undefined ? undefined : value), schema.optional());

const envSchema = z
  .object({
    PP_API_URL: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z.string().url().default('http://localhost:3000'),
    ),
    PP_EMAIL: emptyToUndefined(z.string().email()),
    PP_PASSWORD: emptyToUndefined(z.string().min(1)),
    PP_KEY_ID: emptyToUndefined(z.coerce.number().int().positive()),
    PP_KEY_TYPE: emptyToUndefined(z.enum(KEY_TYPES)),
    PP_PRIVATE_KEY_PATH: emptyToUndefined(z.string().min(1)),
    PP_PROJECT_ID: emptyToUndefined(z.coerce.number().int().positive()),
    PP_INTERNAL_URL: emptyToUndefined(z.string().url()),
    PP_INTERNAL_TOKEN: emptyToUndefined(z.string().min(1)),
    JWT_SECRET: emptyToUndefined(z.string().min(1)),
    PP_MCP_HOST: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z.string().min(1).default('0.0.0.0'),
    ),
    PP_MCP_PORT: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z.coerce.number().int().min(1).max(65_535).default(3900),
    ),
  })
  .superRefine((env, ctx) => {
    const hasEmail = env.PP_EMAIL !== undefined;
    const hasPassword = env.PP_PASSWORD !== undefined;
    if (hasEmail !== hasPassword) {
      ctx.addIssue({
        code: 'custom',
        message: 'PP_EMAIL und PP_PASSWORD müssen gemeinsam gesetzt sein',
      });
    }

    const hasKeyId = env.PP_KEY_ID !== undefined;
    const hasKeyPath = env.PP_PRIVATE_KEY_PATH !== undefined;
    if (hasKeyId !== hasKeyPath) {
      ctx.addIssue({
        code: 'custom',
        message: 'PP_KEY_ID und PP_PRIVATE_KEY_PATH müssen gemeinsam gesetzt sein',
      });
    }

    if (!(hasEmail && hasPassword) && !(hasKeyId && hasKeyPath)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Keine Zugangsdaten: entweder PP_EMAIL + PP_PASSWORD (Service-Login) oder ' +
          'PP_KEY_ID + PP_PRIVATE_KEY_PATH (SSH-signierte externe API) setzen',
      });
    }
  });

export type McpEnv = z.infer<typeof envSchema>;

/** Parst und validiert die Umgebung; wirft bei fehlerhafter Konfiguration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new Error(`Ungültige MCP-Konfiguration:\n- ${messages.join('\n- ')}`);
  }

  const e = parsed.data;
  const authMode: AuthMode = e.PP_EMAIL !== undefined && e.PP_PASSWORD !== undefined ? 'rest' : 'ssh';

  const config: McpConfig = {
    apiUrl: stripTrailingSlash(e.PP_API_URL),
    authMode,
    host: e.PP_MCP_HOST,
    port: e.PP_MCP_PORT,
  };

  if (e.PP_EMAIL !== undefined) config.email = e.PP_EMAIL;
  if (e.PP_PASSWORD !== undefined) config.password = e.PP_PASSWORD;
  if (e.PP_KEY_ID !== undefined) config.keyId = e.PP_KEY_ID;
  if (e.PP_KEY_TYPE !== undefined) config.keyType = e.PP_KEY_TYPE;
  if (e.PP_PRIVATE_KEY_PATH !== undefined) config.privateKeyPath = e.PP_PRIVATE_KEY_PATH;
  if (e.PP_PROJECT_ID !== undefined) config.projectId = e.PP_PROJECT_ID;

  // Der interne Endpunkt liegt standardmäßig auf derselben Basis wie die API.
  config.internalUrl = stripTrailingSlash(e.PP_INTERNAL_URL ?? e.PP_API_URL);
  const internalToken = e.PP_INTERNAL_TOKEN ?? e.JWT_SECRET;
  if (internalToken !== undefined) config.internalToken = internalToken;

  return config;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
