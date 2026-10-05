import type { Request } from 'express';
import type { z } from 'zod';
import { idSchema } from '@projectplaner/shared';
import { unprocessable } from '../errors.js';

/** Validiert einen Wert gegen ein Zod-Schema und wirft bei Fehlern 422. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw unprocessable(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Parst einen Routenparameter als positive Ganzzahl. */
export function parseId(value: string | undefined, name = 'id'): number {
  const result = idSchema.safeParse(value);
  if (!result.success) {
    throw unprocessable([{ path: name, message: 'Ungültige ID' }]);
  }
  return result.data;
}

/** Liest die Optimistic-Locking-Version aus dem If-Match-Header. */
export function parseIfMatch(req: Request): number | null {
  const header = req.headers['if-match'];
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const value = Number(raw?.replace(/"/g, ''));
  return Number.isInteger(value) && value > 0 ? value : null;
}
