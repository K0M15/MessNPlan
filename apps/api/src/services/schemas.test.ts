import { describe, expect, it } from 'vitest';
import { resourceCreateSchema, resourceUpdateSchema } from '@projectplaner/shared';

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
});
