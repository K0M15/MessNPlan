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

/** Kalender mit Arbeitswoche inklusive Sonntag (FT 0–6). */
function allDaysCalendar(workdayStart = '08:00:00', workdayEnd = '16:00:00'): WorkCalendar {
  return new WorkCalendar({
    timezone: zone,
    workweek: [0, 1, 2, 3, 4, 5, 6],
    workdayStart,
    workdayEnd,
    holidays: new Set(),
  });
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

  it('zählt auch vor 1970 korrekt (rückwärts akkumulierte Tagesfenster)', () => {
    const cal = calendar();
    // Mo 1969-12-29 08:00 – Mi 1969-12-31 16:00 (1.1.1970 = Donnerstag) = 3 volle Tage.
    const minutes = cal.workingMinutesBetween(dt('1969-12-29T08:00'), dt('1969-12-31T16:00'));
    expect(minutes).toBe(480 * 3);
  });
});

describe('WorkCalendar – DST-Umstellungstage (Europe/Berlin)', () => {
  // 2026-03-29: Sommerzeitbeginn (02:00 → 03:00). 2026-10-25: Sommerzeitende (03:00 → 02:00).
  const MARCH_29_08_UTC = Date.UTC(2026, 2, 29, 6, 0); // 08:00 CEST
  const OCT_25_08_UTC = Date.UTC(2026, 9, 25, 7, 0); // 08:00 CET

  it('setzt materialisierte Fenstergrenzen per Wall-Clock, nicht per ms-Addition', () => {
    const cal = allDaysCalendar();
    cal.precomputeRange(dt('2026-03-01T00:00').toMillis(), dt('2026-11-30T00:00').toMillis());
    expect(cal.workdayStartMs('2026-03-29')).toBe(MARCH_29_08_UTC);
    expect(cal.workdayStartMs('2026-10-25')).toBe(OCT_25_08_UTC);
    expect(cal.nextWorkingMoment(dt('2026-03-29T01:00')).toUTC().toISO()).toBe(
      '2026-03-29T06:00:00.000Z',
    );
    expect(cal.nextWorkingMoment(dt('2026-10-25T01:00')).toUTC().toISO()).toBe(
      '2026-10-25T07:00:00.000Z',
    );
    expect(
      cal.workingDayStartsBetween(
        dt('2026-03-29T00:00').toMillis(),
        dt('2026-03-29T23:59').toMillis(),
      ),
    ).toEqual([MARCH_29_08_UTC]);
    expect(cal.workingDaysBetween(dt('2026-03-29T00:00'), dt('2026-03-29T23:59'))).toEqual([
      '2026-03-29',
    ]);
  });

  it('liefert ohne Materialisierung dieselben Grenzen (Slow-Fallback)', () => {
    const cal = allDaysCalendar();
    expect(cal.workdayStartMs('2026-03-29')).toBe(MARCH_29_08_UTC);
    expect(cal.workdayStartMs('2026-10-25')).toBe(OCT_25_08_UTC);
    expect(cal.nextWorkingMoment(dt('2026-03-29T01:00')).toUTC().toISO()).toBe(
      '2026-03-29T06:00:00.000Z',
    );
    expect(cal.nextWorkingMoment(dt('2026-10-25T01:00')).toUTC().toISO()).toBe(
      '2026-10-25T07:00:00.000Z',
    );
  });

  it('Fenster 00:00–08:00 enthält die Umstellung: 420 bzw. 540 Minuten (Slow und materialisiert)', () => {
    const cal = allDaysCalendar('00:00:00', '08:00:00');
    expect(cal.workdayStartMs('2026-03-29')).toBe(Date.UTC(2026, 2, 28, 23, 0)); // 00:00 CET
    expect(cal.workdayStartMs('2026-10-25')).toBe(Date.UTC(2026, 9, 24, 22, 0)); // 00:00 CEST

    const marchSlow = cal.workingMinutesBetween(dt('2026-03-28T00:00'), dt('2026-03-30T08:00'));
    const octoberSlow = cal.workingMinutesBetween(dt('2026-10-24T00:00'), dt('2026-10-26T08:00'));
    expect(marchSlow).toBe(480 + 420 + 480);
    expect(octoberSlow).toBe(480 + 540 + 480);

    cal.precomputeRange(dt('2026-03-01T00:00').toMillis(), dt('2026-11-30T00:00').toMillis());
    expect(cal.workingMinutesBetween(dt('2026-03-28T00:00'), dt('2026-03-30T08:00'))).toBe(
      480 + 420 + 480,
    );
    expect(cal.workingMinutesBetween(dt('2026-10-24T00:00'), dt('2026-10-26T08:00'))).toBe(
      480 + 540 + 480,
    );
  });

  it('addiert/subtrahiert über die Umstellungstage (Slow und materialisiert)', () => {
    const check = (cal: WorkCalendar) => {
      // 2026-03-29 hat real 420 Minuten: 00:00 + 480 → Montag 01:00.
      expect(cal.addWorkingMinutes(dt('2026-03-29T00:00'), 480).toISO()).toBe(
        dt('2026-03-30T01:00').toISO(),
      );
      // 2026-10-25 hat real 540: 00:00 + 480 → 07:00 Ortszeit.
      expect(cal.addWorkingMinutes(dt('2026-10-25T00:00'), 480).toISO()).toBe(
        dt('2026-10-25T07:00').toISO(),
      );
      expect(cal.subtractWorkingMinutes(dt('2026-03-30T00:00'), 60).toISO()).toBe(
        dt('2026-03-29T07:00').toISO(),
      );
      expect(cal.subtractWorkingMinutes(dt('2026-10-26T00:00'), 60).toISO()).toBe(
        dt('2026-10-25T07:00').toISO(),
      );
    };

    check(allDaysCalendar('00:00:00', '08:00:00'));
    const material = allDaysCalendar('00:00:00', '08:00:00');
    material.precomputeRange(dt('2026-03-01T00:00').toMillis(), dt('2026-11-30T00:00').toMillis());
    check(material);
  });
});
