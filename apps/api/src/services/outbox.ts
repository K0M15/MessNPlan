import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { outboxJobs } from '../db/schema.js';

export type OutboxJobType = 'schedule.compute' | 'outlook.sync';

/** Debounce-Fenster: gleichartige Jobs für dasselbe Projekt werden zusammengefasst. */
const COALESCE_DELAY_MS: Record<OutboxJobType, number> = {
  'schedule.compute': 1_500,
  'outlook.sync': 5_000,
};

/**
 * Legt einen Job in der Outbox an. Pending-Jobs gleichen Typs (und gleichen Projekts)
 * werden zuvor entfernt, damit kurze Änderungsserien nur eine Ausführung erzeugen.
 */
export async function enqueueJob(
  type: OutboxJobType,
  payload: Record<string, unknown>,
  options?: { runAt?: Date },
): Promise<void> {
  const projectId =
    payload.projectId === undefined || payload.projectId === null
      ? null
      : String(payload.projectId);
  const runAt = options?.runAt ?? new Date(Date.now() + COALESCE_DELAY_MS[type]);

  await db.transaction(async (tx) => {
    await tx
      .delete(outboxJobs)
      .where(
        and(
          eq(outboxJobs.type, type),
          eq(outboxJobs.status, 'pending'),
          projectId === null
            ? sql`${outboxJobs.payload}->>'$.projectId' is null`
            : sql`${outboxJobs.payload}->>'$.projectId' = ${projectId}`,
        ),
      );
    await tx.insert(outboxJobs).values({
      type,
      payload,
      status: 'pending',
      nextAttemptAt: runAt,
    });
  });
}
