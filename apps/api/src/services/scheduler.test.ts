import { describe, expect, it } from 'vitest';
import type { DateTime } from 'luxon';
import { WorkCalendar } from './calendar.js';
import type { DepEdge } from './dependencyGraph.js';
import type { TaskRow } from './planningData.js';
import { buildPlan } from './scheduler.js';

const TIMEZONE = 'Europe/Berlin';

function calendar(holidays: string[] = []): WorkCalendar {
  return new WorkCalendar({
    timezone: TIMEZONE,
    workweek: [1, 2, 3, 4, 5],
    workdayStart: '08:00:00',
    workdayEnd: '16:00:00',
    holidays: new Set(holidays),
  });
}

let nextId = 100;
function task(partial: Partial<TaskRow> & { parentId?: number | null }): TaskRow {
  const id = partial.id ?? nextId++;
  return {
    id,
    projectId: 1,
    parentId: partial.parentId ?? null,
    name: `Task ${id}`,
    description: null,
    estimatedMinutes: null,
    progress: 0,
    status: 'todo',
    priority: 'normal',
    constraintType: 'asap',
    constraintDate: null,
    isMilestone: false,
    sortOrder: 0,
    plannedStart: null,
    plannedEnd: null,
    actualStart: null,
    actualEnd: null,
    scheduleVersion: 0,
    createdBy: 1,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  } as TaskRow;
}

function edge(predecessorId: number, successorId: number, type: DepEdge['type'] = 'FS', lagMinutes = 0): DepEdge {
  return { id: nextId++, predecessorId, successorId, type, lagMinutes };
}

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null;
}

describe('buildPlan – Summary-Aufgaben (Rollup) und Abhängigkeiten', () => {
  it('Nachfolger einer Summary-Aufgabe startet nach dem Rollup-Ende der Kinder', () => {
    const parent = task({ id: 1 });
    const child = task({ id: 2, parentId: 1, estimatedMinutes: 480 });
    const successor = task({ id: 3, estimatedMinutes: 480 });

    const result = buildPlan({
      tasks: [parent, child, successor],
      edges: [edge(1, 3)],
      calendar: calendar(),
      anchor: '2026-10-05', // Montag
    });

    // Kind: Montag 08:00–16:00 (Berlin) = 06:00–14:00 UTC
    expect(iso(result.planned.get(2)?.start)).toBe('2026-10-05T06:00:00.000Z');
    expect(iso(result.planned.get(2)?.end)).toBe('2026-10-05T14:00:00.000Z');
    // Summary erbt den Kindzeitraum
    expect(iso(result.planned.get(1)?.start)).toBe('2026-10-05T06:00:00.000Z');
    expect(iso(result.planned.get(1)?.end)).toBe('2026-10-05T14:00:00.000Z');
    // Nachfolger startet nach dem Summary-Ende, nicht am Projektanker
    expect(iso(result.planned.get(3)?.start)).toBe('2026-10-05T14:00:00.000Z');
    expect(iso(result.planned.get(3)?.end)).toBe('2026-10-06T14:00:00.000Z');
  });

  it('verschachtelte Summaries rollen von innen nach außen auf', () => {
    const outer = task({ id: 1 });
    const inner = task({ id: 2, parentId: 1 });
    const leafA = task({ id: 3, parentId: 2, estimatedMinutes: 240 });
    const leafB = task({ id: 4, parentId: 2, estimatedMinutes: 240 });
    const successor = task({ id: 5, estimatedMinutes: 60 });

    const result = buildPlan({
      tasks: [outer, inner, leafA, leafB, successor],
      edges: [edge(4, 5), edge(2, 5)],
      calendar: calendar(),
      anchor: '2026-10-05',
    });

    expect(iso(result.planned.get(2)?.start)).toBe('2026-10-05T06:00:00.000Z');
    expect(iso(result.planned.get(2)?.end)).toBe('2026-10-05T10:00:00.000Z');
    expect(iso(result.planned.get(1)?.start)).toBe('2026-10-05T06:00:00.000Z');
    expect(iso(result.planned.get(1)?.end)).toBe('2026-10-05T10:00:00.000Z');
    expect(iso(result.planned.get(5)?.start)).toBe('2026-10-05T10:00:00.000Z');
  });

  it('erkennt Hierarchie-Zyklen (Summary als Vorgänger des eigenen Kindes)', () => {
    const parent = task({ id: 1 });
    const child = task({ id: 2, parentId: 1, estimatedMinutes: 60 });

    const result = buildPlan({
      tasks: [parent, child],
      edges: [edge(1, 2)],
      calendar: calendar(),
      anchor: '2026-10-05',
    });

    expect(result.cyclic.has(1)).toBe(true);
    expect(result.cyclic.has(2)).toBe(true);
    expect(result.planned.get(1)).toEqual({ start: null, end: null });
    expect(result.planned.get(2)).toEqual({ start: null, end: null });
  });
});

describe('buildPlan – Arbeitskalender und Constraints', () => {
  it('überspringt Wochenenden', () => {
    const first = task({ id: 1, estimatedMinutes: 600 }); // 10h → Fr 08:00–16:00 + Rest Montag
    const result = buildPlan({
      tasks: [first],
      edges: [],
      calendar: calendar(),
      anchor: '2026-10-09', // Freitag
    });
    expect(iso(result.planned.get(1)?.end)).toBe('2026-10-12T08:00:00.000Z'); // Montag 10:00 Berlin
  });

  it('überspringt Feiertage', () => {
    const work = task({ id: 1, estimatedMinutes: 720 }); // 12h
    const result = buildPlan({
      tasks: [work],
      edges: [],
      calendar: calendar(['2026-10-06']), // Dienstag Feiertag
      anchor: '2026-10-05', // Montag
    });
    // Montag 08:00–16:00 (8h), Dienstag Feiertag, Mittwoch 08:00 + 4h → 12:00
    expect(iso(result.planned.get(1)?.end)).toBe('2026-10-07T10:00:00.000Z');
  });

  it('respektiert start_no_earlier_than', () => {
    const work = task({
      id: 1,
      estimatedMinutes: 60,
      constraintType: 'start_no_earlier_than',
      constraintDate: new Date('2026-10-07T06:00:00Z'), // Mittwoch 08:00 Berlin
    });
    const result = buildPlan({
      tasks: [work],
      edges: [],
      calendar: calendar(),
      anchor: '2026-10-05',
    });
    expect(iso(result.planned.get(1)?.start)).toBe('2026-10-07T06:00:00.000Z');
  });

  it('lässt Blattaufgaben ohne Schätzung ungeplant', () => {
    const leaf = task({ id: 1, estimatedMinutes: null });
    const result = buildPlan({ tasks: [leaf], edges: [], calendar: calendar(), anchor: '2026-10-05' });
    expect(result.planned.get(1)).toEqual({ start: null, end: null });
  });
});
