import { describe, expect, it } from 'vitest';
import {
  absenceCreateSchema,
  resourceCreateSchema,
  resourceUpdateSchema,
} from '@projectplaner/shared';

describe('Ressourcen-Schemas', () => {
  it('akzeptiert null/"" für optionale E-Mail und Farbe (UI sendet null)', () => {
    const result = resourceCreateSchema.safeParse({
      name: 'CI-Server',
      type: 'machine',
      email: null,
      color: null,
      capacityMinutesPerDay: 1440,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBeUndefined();
      expect(result.data.color).toBeUndefined();
      expect(result.data.name).toBe('CI-Server');
    }
  });

  it('akzeptiert das Leeren der E-Mail per Update', () => {
    const result = resourceUpdateSchema.safeParse({ email: null, color: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBeUndefined();
      expect(result.data.color).toBeUndefined();
    }
  });

  it('weist ungültige E-Mails weiterhin ab', () => {
    const result = resourceCreateSchema.safeParse({ name: 'Anna', email: 'keine-mail' });
    expect(result.success).toBe(false);
  });

  it('validiert strukturierte workingHours (Record Wochentag → start/end)', () => {
    const ok = resourceCreateSchema.safeParse({
      name: 'Anna',
      workingHours: { '1': { start: '08:00', end: '16:00' }, '6': { start: '09:00', end: '12:00' } },
    });
    expect(ok.success).toBe(true);

    expect(
      resourceCreateSchema.safeParse({ name: 'Anna', workingHours: { '1': { start: '16:00', end: '08:00' } } })
        .success,
    ).toBe(false);
    expect(
      resourceCreateSchema.safeParse({ name: 'Anna', workingHours: { '7': { start: '08:00', end: '16:00' } } })
        .success,
    ).toBe(false);
    expect(
      resourceCreateSchema.safeParse({ name: 'Anna', workingHours: { '1': { start: '8 Uhr', end: '16:00' } } })
        .success,
    ).toBe(false);
  });

  it('akzeptiert resourceUpdate workingHours: null (Erbung der Projektzeiten)', () => {
    const result = resourceUpdateSchema.safeParse({ workingHours: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.workingHours).toBeNull();
  });

  it('validiert Abwesenheiten inklusiv und mit Typ/Name', () => {
    const ok = absenceCreateSchema.safeParse({
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      type: 'vacation',
      name: 'Herbsturlaub',
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.type).toBe('vacation');
      expect(ok.data.startDate.toISOString().slice(0, 10)).toBe('2026-10-05');
    }

    // Ein einzelner Tag ist ein gültiger inklusiver Zeitraum.
    expect(
      absenceCreateSchema.safeParse({ startDate: '2026-10-05', endDate: '2026-10-05' }).success,
    ).toBe(true);

    // Ende vor Start → Fehler.
    expect(
      absenceCreateSchema.safeParse({ startDate: '2026-10-09', endDate: '2026-10-05' }).success,
    ).toBe(false);

    // Unbekannter Typ → Fehler.
    expect(
      absenceCreateSchema.safeParse({ startDate: '2026-10-05', endDate: '2026-10-06', type: 'holiday' })
        .success,
    ).toBe(false);
  });
});
