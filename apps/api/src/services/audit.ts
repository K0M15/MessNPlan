import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { logger } from '../logger.js';

export async function writeAudit(opts: {
  userId?: number | null;
  entityType: string;
  entityId?: number | null;
  action: string;
  diff?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: opts.userId ?? null,
      entityType: opts.entityType,
      entityId: opts.entityId ?? null,
      action: opts.action,
      diff: opts.diff ?? null,
    });
  } catch (err) {
    logger.warn({ err, entityType: opts.entityType, action: opts.action }, 'Audit-Log fehlgeschlagen');
  }
}
