import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { config } from '../config.js';
import {
  buildAuthorizeUrl,
  createCalendarEvent,
  deleteCalendarEvent,
  exchangeCodeForTokens,
  generatePkce,
  getMe,
  refreshTokens,
  updateCalendarEvent,
  type GraphEventPayload,
} from './graph.js';

// Deterministische Graph-Konfiguration setzen, bevor config/graph importiert werden.
// dotenv überschreibt bereits gesetzte Variablen nicht, daher gewinnen diese Werte.
vi.hoisted(() => {
  process.env.GRAPH_CLIENT_ID = 'test-client-id';
  process.env.GRAPH_TENANT_ID = 'test-tenant-id';
  process.env.GRAPH_REDIRECT_URI = 'https://app.example.com/api/v1/integrations/outlook/callback';
  process.env.GRAPH_CLIENT_SECRET = 'test-client-secret';
});

type FetchMock = Mock<typeof fetch>;

const expectedAuthority = `https://login.microsoftonline.com/${config.GRAPH_TENANT_ID || 'common'}`;

const payload: GraphEventPayload = {
  subject: '[Projekt Alpha] Aufgabe',
  bodyHtml: '<p>Ressource: <strong>Ada</strong></p>',
  startIso: '2026-10-05T09:30:00.000Z',
  endIso: '2026-10-05T10:15:00.000Z',
  categories: ['ProjectPlaner'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(): FetchMock {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function firstCall(fetchMock: FetchMock): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error('fetch wurde nicht aufgerufen');
  return { url: String(call[0]), init: call[1] };
}

interface EventBody {
  subject: string;
  body: { contentType: string; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  showAs: string;
  categories: string[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAuthorizeUrl', () => {
  it('enthält alle OAuth-PKCE-Parameter und zeigt auf den Tenant', () => {
    const url = new URL(buildAuthorizeUrl('state-123', 'challenge-abc'));

    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe('/test-tenant-id/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/v1/integrations/outlook/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('offline_access');
    expect(scopes).toContain('Calendars.ReadWrite');
    expect(scopes).toContain('User.Read');
  });
});

describe('generatePkce', () => {
  it('erzeugt Verifier und passende S256-Challenge', () => {
    const { verifier, challenge } = generatePkce();

    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('exchangeCodeForTokens', () => {
  it('mappt die Token-Antwort und sendet den Authorization-Code-Flow', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'Calendars.ReadWrite User.Read',
      }),
    );

    const tokens = await exchangeCodeForTokens('code-123', 'verifier-123');

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe(`${expectedAuthority}/oauth2/v2.0/token`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });

    const body = init?.body as URLSearchParams;
    expect(body.get('client_id')).toBe(config.GRAPH_CLIENT_ID);
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-123');
    expect(body.get('redirect_uri')).toBe(config.GRAPH_REDIRECT_URI);
    expect(body.get('code_verifier')).toBe('verifier-123');
    expect(body.get('scope')).toBe('offline_access Calendars.ReadWrite User.Read');

    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.scope).toBe('Calendars.ReadWrite User.Read');
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('wirft bei non-ok Response mit Status und Antworttext', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response('invalid_grant: code abgelaufen', { status: 400 }));

    await expect(exchangeCodeForTokens('bad', 'verifier')).rejects.toThrow(
      /Token-Austausch fehlgeschlagen \(400\).*invalid_grant/,
    );
  });
});

describe('refreshTokens', () => {
  it('übernimmt einen neuen refresh_token', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 }),
    );

    const tokens = await refreshTokens('refresh-1');

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe(`${expectedAuthority}/oauth2/v2.0/token`);
    const body = init?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');

    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBe('refresh-2');
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 1_700_000);
  });

  it('behält den alten refresh_token, wenn keiner geliefert wird', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'access-3', expires_in: 1800 }));

    const tokens = await refreshTokens('refresh-alt');

    expect(tokens.accessToken).toBe('access-3');
    expect(tokens.refreshToken).toBe('refresh-alt');
  });

  it('wirft bei non-ok Response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response('AADSTS70008: expired', { status: 401 }));

    await expect(refreshTokens('refresh-1')).rejects.toThrow(/Token-Refresh fehlgeschlagen \(401\)/);
  });
});

describe('createCalendarEvent', () => {
  it('sendet POST /me/events mit Betreff, Zeiten, showAs und Kategorien', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'event-1', changeKey: 'ck-1' }, 201));

    const created = await createCalendarEvent('access-token', payload);

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(String(init?.body)) as EventBody;
    expect(body.subject).toBe('[Projekt Alpha] Aufgabe');
    expect(body.showAs).toBe('busy');
    expect(body.categories).toEqual(['ProjectPlaner']);
    expect(body.start).toEqual({ dateTime: '2026-10-05T09:30:00', timeZone: 'UTC' });
    expect(body.end).toEqual({ dateTime: '2026-10-05T10:15:00', timeZone: 'UTC' });
    expect(body.body).toEqual({ contentType: 'HTML', content: '<p>Ressource: <strong>Ada</strong></p>' });

    expect(created).toEqual({ id: 'event-1', changeKey: 'ck-1' });
  });
});

describe('updateCalendarEvent', () => {
  it('behandelt 404 als null (in Outlook gelöscht)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const result = await updateCalendarEvent('access-token', 'event-1', payload);

    expect(result).toBeNull();
    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events/event-1');
    expect(init?.method).toBe('PATCH');
  });

  it('liefert bei Erfolg das aktualisierte Event', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'event-1', changeKey: 'ck-2' }));

    const result = await updateCalendarEvent('access-token', 'event id/1', payload);

    expect(result).toEqual({ id: 'event-1', changeKey: 'ck-2' });
    expect(firstCall(fetchMock).url).toBe(
      'https://graph.microsoft.com/v1.0/me/events/event%20id%2F1',
    );
  });
});

describe('deleteCalendarEvent', () => {
  it('sendet DELETE auf /me/events/<id>', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteCalendarEvent('access-token', 'event-1')).resolves.toBeUndefined();

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events/event-1');
    expect(init?.method).toBe('DELETE');
  });

  it('wirft bei 404 nicht', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(deleteCalendarEvent('access-token', 'schon-weg')).resolves.toBeUndefined();
  });
});

describe('getMe', () => {
  it('liest mail und userPrincipalName', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ mail: 'ada@example.com', userPrincipalName: 'ada@contoso.onmicrosoft.com' }),
    );

    const me = await getMe('access-token');

    expect(firstCall(fetchMock).url).toBe(
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
    );
    expect(me).toEqual({
      mail: 'ada@example.com',
      userPrincipalName: 'ada@contoso.onmicrosoft.com',
    });
  });
});
