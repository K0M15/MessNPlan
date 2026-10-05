import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export const GRAPH_SCOPES = ['offline_access', 'Calendars.ReadWrite', 'User.Read'] as const;

export function graphConfigured(): boolean {
  return Boolean(config.GRAPH_CLIENT_ID && config.GRAPH_REDIRECT_URI);
}

function authority(): string {
  return `https://login.microsoftonline.com/${config.GRAPH_TENANT_ID || 'common'}`;
}

export interface GraphTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: config.GRAPH_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: config.GRAPH_REDIRECT_URI ?? '',
    response_mode: 'query',
    scope: GRAPH_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${authority()}/oauth2/v2.0/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<GraphTokens> {
  const body = new URLSearchParams({
    client_id: config.GRAPH_CLIENT_ID ?? '',
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.GRAPH_REDIRECT_URI ?? '',
    code_verifier: codeVerifier,
    scope: GRAPH_SCOPES.join(' '),
  });
  if (config.GRAPH_CLIENT_SECRET) {
    body.set('client_secret', config.GRAPH_CLIENT_SECRET);
  }

  const response = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token-Austausch fehlgeschlagen (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scope: data.scope ?? GRAPH_SCOPES.join(' '),
  };
}

export async function refreshTokens(refreshToken: string): Promise<GraphTokens> {
  const body = new URLSearchParams({
    client_id: config.GRAPH_CLIENT_ID ?? '',
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: GRAPH_SCOPES.join(' '),
  });
  if (config.GRAPH_CLIENT_SECRET) {
    body.set('client_secret', config.GRAPH_CLIENT_SECRET);
  }

  const response = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token-Refresh fehlgeschlagen (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scope: data.scope ?? GRAPH_SCOPES.join(' '),
  };
}

async function graphRequest<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 404 && method !== 'GET') return null;
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Graph ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
}

export async function getMe(accessToken: string): Promise<{ mail?: string; userPrincipalName: string }> {
  const me = await graphRequest<{ mail?: string; userPrincipalName: string }>(
    accessToken,
    'GET',
    '/me?$select=mail,userPrincipalName',
  );
  if (!me) throw new Error('Benutzerprofil konnte nicht geladen werden');
  return me;
}

export interface GraphEventPayload {
  subject: string;
  bodyHtml: string;
  startIso: string;
  endIso: string;
  categories: string[];
}

function graphDateTime(iso: string): { dateTime: string; timeZone: string } {
  // Graph erwartet lokale Zeit ohne Offset, wenn eine Zeitzone angegeben ist.
  return { dateTime: iso.replace(/Z$/, '').slice(0, 19), timeZone: 'UTC' };
}

function toEventBody(payload: GraphEventPayload): Record<string, unknown> {
  return {
    subject: payload.subject,
    body: { contentType: 'HTML', content: payload.bodyHtml },
    start: graphDateTime(payload.startIso),
    end: graphDateTime(payload.endIso),
    showAs: 'busy',
    categories: payload.categories,
  };
}

export async function createCalendarEvent(
  accessToken: string,
  payload: GraphEventPayload,
): Promise<{ id: string; changeKey?: string }> {
  const created = await graphRequest<{ id: string; changeKey?: string }>(
    accessToken,
    'POST',
    '/me/events',
    toEventBody(payload),
  );
  if (!created) throw new Error('Kalendereintrag konnte nicht erstellt werden');
  return created;
}

export async function updateCalendarEvent(
  accessToken: string,
  eventId: string,
  payload: GraphEventPayload,
): Promise<{ id: string; changeKey?: string } | null> {
  return graphRequest<{ id: string; changeKey?: string }>(
    accessToken,
    'PATCH',
    `/me/events/${encodeURIComponent(eventId)}`,
    toEventBody(payload),
  );
}

export async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<void> {
  await graphRequest<null>(accessToken, 'DELETE', `/me/events/${encodeURIComponent(eventId)}`);
}
