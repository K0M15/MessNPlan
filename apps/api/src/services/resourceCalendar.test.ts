import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { WorkingHours } from '@projectplaner/shared';
import {
  addIsoDays,
  availableMinutesOn,
  buildAbsenceIndex,
  capacityMinutesOn,
  isAbsentOn,
  isAvailableOn,
  isoToEpochDay,
  resourceDaysBetween,
  resourceWorkWindows,
  type ProjectLike,
  type ResourceLike,
} from './resourceCalendar.js';

const zone = 'Europe/Berlin';

const project: ProjectLike = {
  timezone: zone,
  workweek: [1, 2, 3, 4, 5],
  workdayStart: '08:00:00',
  workdayEnd: '16:00:00',
};

function resource(workingHours: WorkingHours | null, capacityMinutesPerDay = 480): ResourceLike {
  return { workingHours, capacityMinutesPerDay };
}

// 2026-10-05 = Montag, 2026-10-10 = Samstag, 2026-10-11 = Sonntag.
const MONDAY = '2026-10-05';
const SATURDAY = '2026-10-10';
const SUNDAY = '2026-10-11';

describe('resourceWorkWindows', () => {
  it('erbt ohne eigene Arbeitszeiten Projekt-Arbeitswoche und -zeiten', () => {
    const windows = resourceWorkWindows(resource(null), project);
    expect([...windows.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(windows.get(1)).toMatchObject({ startMinutes: 8 * 60, endMinutes: 16 * 60, minutes: 480 });
  });

  it('nutzt eigene Wochentage statt der Projektwoche', () => {
    const windows = resourceWorkWindows(
      resource({ '6': { start: '08:00', end: '12:00' } }),
      project,
    );
    expect([...windows.keys()]).toEqual([6]);
    expect(windows.get(6)).toMatchObject({ startMinutes: 480, endMinutes: 720, minutes: 240 });
  });

  it('unterstützt Wochenendarbeit (Sonntag)', () => {
    const r = resource({ '0': { start: '10:00', end: '14:30' } });
    expect(isAvailableOn(r, project, SUNDAY)).toBe(true);
    expect(availableMinutesOn(r, project, SUNDAY)).toBe(270);
    expect(isAvailableOn(r, project, MONDAY)).toBe(false);
  });

  it('ignoriert ungültige Einträge (start >= end), leeres Objekt = keine Verfügbarkeit', () => {
    const invalid = resourceWorkWindows(
      resource({ '1': { start: '16:00', end: '08:00' } }),
      project,
    );
    expect(invalid.size).toBe(0);

    const empty = resourceWorkWindows(resource({}), project);
    expect(empty.size).toBe(0);
    expect(availableMinutesOn(resource({}), project, MONDAY)).toBe(0);
  });

  it('aktualisiert den Cache bei gewechseltem Projekt-Objekt', () => {
    const r = resource(null);
    const weekdays = resourceWorkWindows(r, project);
    expect(weekdays.has(1)).toBe(true);

    const weekendProject: ProjectLike = { ...project, workweek: [0, 6] };
    const weekend = resourceWorkWindows(r, weekendProject);
    expect([...weekend.keys()].sort()).toEqual([0, 6]);
  });
});

describe('Abwesenheiten', () => {
  const ranges = buildAbsenceIndex([
    { resourceId: 1, startDate: '2026-10-06', endDate: '2026-10-08' },
    // Überlappender Bereich wird zusammengeführt.
    { resourceId: 1, startDate: '2026-10-08', endDate: '2026-10-09' },
  ]);

  it('behandelt den Zeitraum inklusiv (start_date … end_date)', () => {
    const list = ranges.get(1)!;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      startDay: isoToEpochDay('2026-10-06'),
      endDay: isoToEpochDay('2026-10-09'),
    });
  });

  it('setzt Verfügbarkeit und Minuten an Abwesenheitstagen auf 0', () => {
    const r = resource(null);
    expect(isAbsentOn(ranges.get(1), isoToEpochDay('2026-10-08'))).toBe(true);
    expect(isAvailableOn(r, project, '2026-10-08', ranges.get(1))).toBe(false);
    expect(availableMinutesOn(r, project, '2026-10-08', ranges.get(1))).toBe(0);
    expect(capacityMinutesOn(r, project, '2026-10-08', ranges.get(1))).toBe(0);
    // Direkt davor/danach wieder verfügbar (07.10. abwesend wegen Überlappung → 05.10./09.10.).
    expect(availableMinutesOn(r, project, '2026-10-05', ranges.get(1))).toBe(480);
    expect(availableMinutesOn(r, project, '2026-10-09', ranges.get(1))).toBe(0);
    expect(availableMinutesOn(r, project, '2026-10-12', ranges.get(1))).toBe(480);
  });
});

describe('Feiertage sind für Ressourcen kein Sonderfall', () => {
  it('bleibt am Feiertag verfügbar (Weihnachten 2026, Freitag)', () => {
    const r = resource(null);
    expect(isAvailableOn(r, project, '2026-12-25')).toBe(true);
    expect(availableMinutesOn(r, project, '2026-12-25')).toBe(480);
  });

  it('Feiertagsarbeit erzeugt keine Abwesenheit', () => {
    const r = resource({ '5': { start: '08:00', end: '12:00' } });
    const days = resourceDaysBetween(r, project, undefined, ms('2026-12-25T00:00'), ms('2026-12-26T00:00'));
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ iso: '2026-12-25', absent: false, capacityMinutes: 240 });
  });
});

describe('resourceDaysBetween', () => {
  it('liefert Wochentags-Arbeitstage inkl. Abwesenheitstag mit Kapazität 0', () => {
    const r = resource(null);
    const ranges = buildAbsenceIndex([{ resourceId: 2, startDate: MONDAY, endDate: MONDAY }]).get(2);
    const days = resourceDaysBetween(
      r,
      project,
      ranges,
      ms('2026-10-05T08:00'),
      ms('2026-10-11T16:00'),
    );
    expect(days.map((d) => d.iso)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(days[0]).toMatchObject({ absent: true, capacityMinutes: 0 });
    expect(days[1]).toMatchObject({ absent: false, capacityMinutes: 480 });
    // Fensterbeginn in UTC (Berlin ist im Oktober UTC+2).
    expect(days[0]!.startMs).toBe(DateTime.fromISO('2026-10-05T08:00', { zone }).toMillis());
  });

  it('begrenzt die Tageskapazität durch capacityMinutesPerDay', () => {
    const r = resource({ '1': { start: '08:00', end: '16:00' } }, 240);
    const days = resourceDaysBetween(r, project, undefined, ms('2026-10-05T00:00'), ms('2026-10-05T23:59'));
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ windowMinutes: 480, capacityMinutes: 240 });
  });

  it('liefert für Wochenendtage ohne Fenster keine Einträge', () => {
    const r = resource(null);
    const days = resourceDaysBetween(r, project, undefined, ms(SATURDAY + 'T00:00'), ms(SUNDAY + 'T23:59'));
    expect(days).toEqual([]);
  });
});

describe('resourceDaysBetween – DST-Umstellungstage (Europe/Berlin)', () => {
  // 2026-03-29 (Sonntag): Sommerzeitbeginn. 2026-10-25 (Sonntag): Sommerzeitende.
  it('Fenster 08:00–16:00 startet in UTC korrekt (eigene Sonntagsarbeitszeit)', () => {
    const r = resource({ '0': { start: '08:00', end: '16:00' } });
    const spring = resourceDaysBetween(r, project, undefined, ms('2026-03-29T00:00'), ms('2026-03-29T23:59'));
    expect(spring).toHaveLength(1);
    expect(spring[0]).toMatchObject({
      iso: '2026-03-29',
      startMs: Date.UTC(2026, 2, 29, 6, 0), // 08:00 CEST
      endMs: Date.UTC(2026, 2, 29, 14, 0),
      windowMinutes: 480,
      capacityMinutes: 480,
    });

    const fall = resourceDaysBetween(r, project, undefined, ms('2026-10-25T00:00'), ms('2026-10-25T23:59'));
    expect(fall).toHaveLength(1);
    expect(fall[0]).toMatchObject({
      iso: '2026-10-25',
      startMs: Date.UTC(2026, 9, 25, 7, 0), // 08:00 CET
      endMs: Date.UTC(2026, 9, 25, 15, 0),
      windowMinutes: 480,
      capacityMinutes: 480,
    });
  });

  it('Fenster 00:00–08:00 enthält die Umstellung: 420 bzw. 540 Minuten', () => {
    const r = resource({ '0': { start: '00:00', end: '08:00' } });
    const spring = resourceDaysBetween(r, project, undefined, ms('2026-03-29T00:00'), ms('2026-03-29T23:59'));
    expect(spring[0]).toMatchObject({
      startMs: Date.UTC(2026, 2, 28, 23, 0), // 00:00 CET
      endMs: Date.UTC(2026, 2, 29, 6, 0), // 08:00 CEST
      windowMinutes: 420,
      capacityMinutes: 420,
    });

    const fall = resourceDaysBetween(r, project, undefined, ms('2026-10-25T00:00'), ms('2026-10-25T23:59'));
    expect(fall[0]).toMatchObject({
      startMs: Date.UTC(2026, 9, 24, 22, 0), // 00:00 CEST
      endMs: Date.UTC(2026, 9, 25, 7, 0), // 08:00 CET
      windowMinutes: 540,
      capacityMinutes: 480, // capacityMinutesPerDay bleibt Obergrenze
    });
  });

  it('availableMinutesOn/capacityMinutesOn sind DST-korrekt', () => {
    const r = resource({ '0': { start: '00:00', end: '08:00' } });
    expect(availableMinutesOn(r, project, '2026-03-29')).toBe(420);
    expect(capacityMinutesOn(r, project, '2026-03-29')).toBe(420);
    expect(availableMinutesOn(r, project, '2026-10-25')).toBe(540);
    expect(capacityMinutesOn(r, project, '2026-10-25')).toBe(480);
  });
});

describe('begrenzter Tagesfenster-Cache', () => {
  it('liefert nach Überschreiten des Caps weiterhin korrekte Werte (FIFO-Eviction)', () => {
    const r = resource({ '0': { start: '08:00', end: '16:00' } });
    let iso = '2000-01-02'; // Sonntag
    for (let i = 0; i < 2100; i++) {
      expect(availableMinutesOn(r, project, iso)).toBe(480);
      iso = addIsoDays(iso, 7);
    }

    // Nach vielen Evictions bleiben DST-Fenster unverändert korrekt.
    const spring = resourceDaysBetween(r, project, undefined, ms('2026-03-29T00:00'), ms('2026-03-29T23:59'));
    expect(spring[0]).toMatchObject({
      startMs: Date.UTC(2026, 2, 29, 6, 0),
      windowMinutes: 480,
    });
    expect(availableMinutesOn(r, project, '2026-10-25')).toBe(480);
  });
});

function ms(localIso: string): number {
  return DateTime.fromISO(localIso, { zone }).toMillis();
}
