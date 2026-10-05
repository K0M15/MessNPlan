import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { WorkCalendar } from './calendar.js';

const zone = 'Europe/Berlin';

function calendar(holidays: string[] = []): WorkCalendar {
  return new WorkCalendar({
    timezone: zone,
    workweek: [1, 2, 3, 4, 5],
    workdayStart: '08:00:00',
    workdayEnd: '16:00:00',
    holidays: new Set(holidays),
  });
}

function dt(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone });
}

describe('WorkCalendar', () => {
  it('addiert Minuten innerhalb eines Arbeitstags', () => {
    const cal = calendar();
    const result = cal.addWorkingMinutes(dt('2026-10-05T09:00'), 120);
    expect(result.toISO()).toBe(dt('2026-10-05T11:00').toISO());
  });

  it('springt über das Wochenende', () => {
    const cal = calendar();
    // Freitag 15:00 + 120 Minuten = Montag 09:00
    const result = cal.addWorkingMinutes(dt('2026-10-09T15:00'), 120);
    expect(result.toISO()).toBe(dt('2026-10-12T09:00').toISO());
  });

  it('überspringt Feiertage', () => {
    const cal = calendar(['2026-10-08']);
    // Mittwoch 15:00 + 120 Minuten; Donnerstag ist Feiertag → Freitag 09:00
    const result = cal.addWorkingMinutes(dt('2026-10-07T15:00'), 120);
    expect(result.toISO()).toBe(dt('2026-10-09T09:00').toISO());
  });

  it('startet vor Arbeitsbeginn am nächsten Arbeitszeitpunkt', () => {
    const cal = calendar();
    const result = cal.addWorkingMinutes(dt('2026-10-05T05:00'), 60);
    expect(result.toISO()).toBe(dt('2026-10-05T09:00').toISO());
  });

  it('subtrahiert Minuten über den Wochenanfang', () => {
    const cal = calendar();
    // Montag 09:00 − 120 Minuten = Freitag 15:00
    const result = cal.subtractWorkingMinutes(dt('2026-10-12T09:00'), 120);
    expect(result.toISO()).toBe(dt('2026-10-09T15:00').toISO());
  });

  it('zählt Arbeitsminuten zwischen zwei Zeitpunkten', () => {
    const cal = calendar();
    const minutes = cal.workingMinutesBetween(dt('2026-10-05T08:00'), dt('2026-10-06T16:00'));
    expect(Math.round(minutes)).toBe(960);
  });

  it('ignoriert Wochenenden in workingMinutesBetween', () => {
    const cal = calendar();
    const minutes = cal.workingMinutesBetween(dt('2026-10-09T16:00'), dt('2026-10-12T08:00'));
    expect(Math.round(minutes)).toBe(0);
  });

  it('setzt den Anker auf den nächsten Arbeitstag um Arbeitsbeginn', () => {
    const cal = calendar();
    const anchor = cal.anchorMoment('2026-10-10'); // Samstag
    expect(anchor.toISO()).toBe(dt('2026-10-12T08:00').toISO());
  });
});
