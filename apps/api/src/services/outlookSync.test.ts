import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { config } from '../config.js';
import { createCalendarEvent } from './graph.js';
import { escapeHtml, eventPayload, mailboxOf } from './outlookSync.js';

type FetchMock = Mock<typeof fetch>;

interface EventBody {
  body: { contentType: string; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  showAs: string;
  categories: string[];
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('escapeHtml', () => {
  it('neutralisiert < > & " und \'', () => {
    expect(escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    expect(escapeHtml('harmlos')).toBe('harmlos');
  });
});

describe('eventPayload', () => {
  it('erzeugt Betreff, Kategorien und escaped den Ressourcennamen im HTML-Body', () => {
    const payload = eventPayload(
      'Projekt Alpha',
      7,
      'Aufgabe <Test>',
      '<img src=x onerror=alert(1)>',
      new Date('2026-10-05T09:30:00.000Z'),
      new Date('2026-10-05T10:00:00.000Z'),
    );

    expect(payload.subject).toBe('[Projekt Alpha] Aufgabe <Test>');
    expect(payload.categories).toEqual(['ProjectPlaner']);
    expect(payload.startIso).toBe('2026-10-05T09:30:00.000Z');
    expect(payload.endIso).toBe('2026-10-05T10:00:00.000Z');
    expect(payload.bodyHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(payload.bodyHtml).not.toContain('<img');
    expect(payload.bodyHtml).toContain(
      `href="${config.APP_ORIGIN.replace(/\/$/, '')}/projects/7"`,
    );
  });

  it('kommt im Graph-Body als busy/UTC-Termin mit Kategorien an', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'event-1', changeKey: 'ck-1' }, 201));

    const payload = eventPayload(
      'Projekt Alpha',
      7,
      'Aufgabe',
      '<img src=x onerror=alert(1)>',
      new Date('2026-10-05T09:30:00.000Z'),
      new Date('2026-10-05T11:00:00.000Z'),
    );
    await createCalendarEvent('access-token', payload);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body)) as EventBody;

    expect(body.showAs).toBe('busy');
    expect(body.categories).toEqual(['ProjectPlaner']);
    expect(body.start).toEqual({ dateTime: '2026-10-05T09:30:00', timeZone: 'UTC' });
    expect(body.end).toEqual({ dateTime: '2026-10-05T11:00:00', timeZone: 'UTC' });
    expect(body.body.contentType).toBe('HTML');
    expect(body.body.content).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body.body.content).not.toContain('<img');
  });
});

describe('mailboxOf', () => {
  it('nutzt mail, sonst userPrincipalName', async () => {
    const fetchMock = stubFetch();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ mail: 'person@example.com', userPrincipalName: 'person@contoso.onmicrosoft.com' }),
    );
    await expect(mailboxOf('access-token')).resolves.toBe('person@example.com');

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ userPrincipalName: 'person@contoso.onmicrosoft.com' }),
    );
    await expect(mailboxOf('access-token')).resolves.toBe('person@contoso.onmicrosoft.com');
  });
});
