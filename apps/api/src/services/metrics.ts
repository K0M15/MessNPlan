import type { NextFunction, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { db } from '../db/client.js';
import { outboxJobs } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * Prometheus-Metriken der API.
 *
 * Wichtig: Der /metrics-Endpunkt ist nur für das interne Docker-Netz gedacht
 * (Caddy leitet ihn nicht weiter, siehe docs/operations/monitoring.md).
 */
export const register = new Registry();

// Node-/Prozess-Metriken (CPU, Event-Loop-Lag, Heap, GC, ...) mit Präfix `pp_`.
collectDefaultMetrics({ register, prefix: 'pp_' });

const OUTBOX_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;

const httpRequestDuration = new Histogram({
  name: 'pp_http_request_duration_seconds',
  help: 'Dauer der HTTP-Requests in Sekunden (Label route = Express-Route-Pattern).',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

const httpRequestsTotal = new Counter({
  name: 'pp_http_requests_total',
  help: 'Anzahl der HTTP-Requests (Label route = Express-Route-Pattern).',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

const outboxJobsGauge = new Gauge({
  name: 'pp_outbox_jobs',
  help: 'Aktuelle Anzahl der Outbox-Jobs je Status (wird bei jedem Scrape aus der DB aktualisiert).',
  labelNames: ['status'] as const,
  registers: [register],
});

// Alle Status mit 0 vorbelegen, damit die Serien auch bei leerer Tabelle existieren.
for (const status of OUTBOX_STATUSES) {
  outboxJobsGauge.labels(status).set(0);
}

/**
 * Misst jeden Request nach `finish` und zählt ihn nach Route-Pattern.
 *
 * Das vollständige Pattern (inkl. Mount-Prefix, z. B.
 * `/api/v1/projects/:projectId/tasks`) wird beim Setzen von `req.route`
 * erfasst: Express setzt `req.route` genau beim Matchen der Route, stellt
 * `req.baseUrl` aber schon beim Verlassen der Router wieder zurück. Bei
 * Fehlerantworten (Antwort über `next(err)`) wäre `req.baseUrl` beim
 * `finish`-Event sonst bereits leer und der Prefix würde fehlen.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Der Scrape-Endpunkt selbst soll die HTTP-Metriken nicht verfälschen.
  if (req.path === '/metrics') {
    next();
    return;
  }

  // Kein `req.path` als Fallback: URLs können IDs enthalten und würden die
  // Label-Kardinalität sprengen. Nicht gematchte Requests landen gesammelt
  // unter `unmatched`.
  let routeLabel = 'unmatched';
  let routeRef: unknown;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => routeRef,
    set: (value: unknown) => {
      routeRef = value;
      const routePath = (value as { path?: unknown } | null | undefined)?.path;
      const pattern =
        typeof routePath === 'string' ? routePath : Array.isArray(routePath) ? routePath[0] : undefined;
      if (typeof pattern === 'string' && pattern.length > 0) {
        routeLabel = `${req.baseUrl}${pattern}` || '/';
      }
    },
  });

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const labels = {
      method: req.method,
      route: routeLabel,
      status: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, seconds);
    httpRequestsTotal.inc(labels);
  });
  next();
}

/**
 * Lädt die aktuellen Outbox-Zählungen aus der DB. Fehler werden bewusst
 * toleriert: Der /metrics-Request bleibt erfolgreich, die Gauge behält
 * einfach ihren letzten Stand.
 */
export async function refreshDbMetrics(): Promise<void> {
  try {
    const rows = await db
      .select({ status: outboxJobs.status, count: sql<number>`count(*)` })
      .from(outboxJobs)
      .groupBy(outboxJobs.status);

    const counts = new Map<string, number>(rows.map((row) => [row.status, Number(row.count)]));
    for (const status of OUTBOX_STATUSES) {
      outboxJobsGauge.labels(status).set(counts.get(status) ?? 0);
    }
  } catch (err) {
    logger.warn({ err }, 'Outbox-Metriken konnten nicht aktualisiert werden');
  }
}

/** Express-Handler für `GET /metrics` (Prometheus Textformat). */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  await refreshDbMetrics();
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
}
