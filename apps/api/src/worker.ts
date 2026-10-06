import { and, asc, eq, inArray, isNotNull, lt, lte, or } from 'drizzle-orm';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { closeDatabase, db } from './db/client.js';
import { auditLog, outboxJobs, refreshTokens } from './db/schema.js';
import { ApiError } from './errors.js';
import { logger } from './logger.js';
import { runOutlookSync } from './services/outlookSync.js';
import { enqueueJob } from './services/outbox.js';
import { computeSchedule } from './services/scheduler.js';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 5_000);
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 5;
const STALE_JOB_TIMEOUT_MS = 10 * 60_000;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000;

type Job = typeof outboxJobs.$inferSelect;

let running = true;
let activeJob = false;
let lastMaintenance = 0;

function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 2 ** attempts * 10_000);
}

function isTerminalError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

async function notifyApi(projectId: number, event: string, payload: unknown): Promise<void> {
  const baseUrl = process.env.API_INTERNAL_URL ?? `http://localhost:${config.API_PORT}`;
  try {
    const response = await fetch(`${baseUrl}/internal/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': config.JWT_SECRET,
      },
      body: JSON.stringify({ projectId, event, payload }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, projectId, event }, 'Broadcast fehlgeschlagen');
    }
  } catch (err) {
    logger.warn({ err, projectId, event }, 'Broadcast nicht erreichbar');
  }
}

async function runJob(job: Job): Promise<void> {
  switch (job.type) {
    case 'schedule.compute': {
      const projectId = Number(job.payload.projectId);
      const result = await computeSchedule(projectId);
      await notifyApi(projectId, 'schedule:updated', result);
      // Nach jeder Neuberechnung ggf. Kalendertermine nachziehen (entprellt).
      await enqueueJob('outlook.sync', { reason: 'schedule.compute', projectId });
      return;
    }
    case 'outlook.sync': {
      const rawProjectId = job.payload.projectId;
      const projectId =
        rawProjectId === undefined || rawProjectId === null ? undefined : Number(rawProjectId);
      const summary = await runOutlookSync({
        projectId: Number.isInteger(projectId) ? projectId : undefined,
      });
      logger.info(summary, 'Outlook-Sync abgeschlossen');
      return;
    }
    default:
      throw new ApiError(422, 'Unbekannter Job-Typ', `Job-Typ "${job.type}" wird nicht unterstützt`);
  }
}

async function claimJobs(): Promise<Job[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxJobs)
      .where(and(eq(outboxJobs.status, 'pending'), lte(outboxJobs.nextAttemptAt, new Date())))
      .orderBy(asc(outboxJobs.nextAttemptAt), asc(outboxJobs.id))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    for (const row of rows) {
      await tx.update(outboxJobs).set({ status: 'processing' }).where(eq(outboxJobs.id, row.id));
    }
    return rows;
  });
}

async function finishJob(job: Job, error: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  if (error) {
    const terminal = isTerminalError(error) || attempts >= MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ jobId: job.id, type: job.type, attempts, terminal, err: message }, 'Job fehlgeschlagen');
    await db
      .update(outboxJobs)
      .set({
        status: terminal ? 'failed' : 'pending',
        attempts,
        lastError: message.slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      })
      .where(eq(outboxJobs.id, job.id));
    return;
  }

  await db
    .update(outboxJobs)
    .set({ status: 'done', attempts, lastError: null })
    .where(eq(outboxJobs.id, job.id));
}

/** Nach einem Crash liegengebliebene "processing"-Jobs zurücksetzen. */
async function recoverStaleJobs(): Promise<void> {
  const [result] = await db
    .update(outboxJobs)
    .set({ status: 'pending', nextAttemptAt: new Date() })
    .where(
      and(
        eq(outboxJobs.status, 'processing'),
        lt(outboxJobs.updatedAt, new Date(Date.now() - STALE_JOB_TIMEOUT_MS)),
      ),
    );
  if (result.affectedRows > 0) {
    logger.warn({ count: result.affectedRows }, 'Verwaiste Jobs zurückgesetzt');
  }
}

/** Abgelaufene/widerrufene Refresh-Tokens aufräumen. */
async function pruneRefreshTokens(): Promise<void> {
  const now = Date.now();
  const [result] = await db
    .delete(refreshTokens)
    .where(
      or(
        lt(refreshTokens.expiresAt, new Date(now - 7 * 86_400_000)),
        and(
          isNotNull(refreshTokens.revokedAt),
          lt(refreshTokens.revokedAt, new Date(now - 30 * 86_400_000)),
        ),
      ),
    );
  if (result.affectedRows > 0) {
    logger.info({ count: result.affectedRows }, 'Abgelaufene Refresh-Tokens gelöscht');
  }
}

/** Abgeschlossene/endgültig fehlgeschlagene Outbox-Jobs nach 14 Tagen entfernen. */
async function pruneOutboxJobs(): Promise<void> {
  const [result] = await db
    .delete(outboxJobs)
    .where(
      and(
        inArray(outboxJobs.status, ['done', 'failed']),
        lt(outboxJobs.updatedAt, new Date(Date.now() - 14 * 86_400_000)),
      ),
    );
  if (result.affectedRows > 0) {
    logger.info({ count: result.affectedRows }, 'Alte Outbox-Jobs gelöscht');
  }
}

/** Audit-Log gemäß Aufbewahrungsrichtlinie (180 Tage) kürzen. */
async function pruneAuditLog(): Promise<void> {
  const [result] = await db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, new Date(Date.now() - 180 * 86_400_000)));
  if (result.affectedRows > 0) {
    logger.info({ count: result.affectedRows }, 'Alte Audit-Einträge gelöscht');
  }
}

async function maintenance(): Promise<void> {
  if (Date.now() - lastMaintenance < MAINTENANCE_INTERVAL_MS) return;
  lastMaintenance = Date.now();
  await recoverStaleJobs();
  await pruneRefreshTokens();
  await pruneOutboxJobs();
  await pruneAuditLog();
}

async function loop(): Promise<void> {
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Worker-Schleife gestartet');
  try {
    await recoverStaleJobs();
    await pruneRefreshTokens();
    await pruneOutboxJobs();
    await pruneAuditLog();
  } catch (err) {
    logger.error({ err }, 'Start-Wartung fehlgeschlagen – Worker läuft weiter');
  }
  lastMaintenance = Date.now();

  while (running) {
    let processed = 0;
    try {
      const jobs = await claimJobs();
      for (const job of jobs) {
        if (!running) break;
        activeJob = true;
        try {
          await runJob(job);
          await finishJob(job, null);
        } catch (err) {
          await finishJob(job, err);
        } finally {
          activeJob = false;
        }
        processed += 1;
      }
      await maintenance();
    } catch (err) {
      logger.error({ err }, 'Fehler in der Worker-Schleife');
    }
    if (processed === 0) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker fährt herunter');
  running = false;
  const deadline = Date.now() + 10_000;
  while (activeJob && Date.now() < deadline) {
    await sleep(100);
  }
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

loop().catch(async (err) => {
  logger.fatal({ err }, 'Worker abgestürzt');
  await closeDatabase();
  process.exit(1);
});
