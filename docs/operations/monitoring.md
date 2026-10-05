# Monitoring (Runbook)

Die API liefert Health-Endpunkte für Container-Orchestrierung und
Prometheus-Metriken für das Monitoring. Beides ist für den internen Betrieb
gedacht – der Metrik-Endpunkt wird **nicht** über Caddy veröffentlicht.

## Healthchecks

| Endpunkt | Zweck | Antwort |
|---|---|---|
| `GET /healthz` | Liveness: Prozess läuft (ohne DB-Zugriff) | `200 {"status":"ok","uptime":…}` |
| `GET /readyz` | Readiness: DB erreichbar (`SELECT 1`) | `200 {"status":"ok"}` bzw. `503 {"status":"unavailable","checks":{"database":false}}` |

- Der Compose-Healthcheck der API nutzt `http://127.0.0.1:3000/healthz`.
- Caddy beantwortet `/healthz` selbst (`respond "ok" 200`); `/readyz` ist nur
  intern erreichbar (`docker compose exec api wget -qO- http://127.0.0.1:3000/readyz`).
- Für externes Monitoring eignet sich ein Blackbox-Exporter auf `https://$DOMAIN/healthz`.

## Prometheus-Metriken

Die API exportiert unter `GET /metrics` das Prometheus-Textformat
(`text/plain; version=0.0.4`). Beim Scrape werden zusätzlich die
Outbox-Zählungen aus der Datenbank gelesen; schlägt die Abfrage fehl, bleibt
der letzte Stand erhalten und der Scrape liefert trotzdem `200`.

Intern erreichbar:

```bash
# Dev (API auf dem Host)
curl -s http://localhost:3000/metrics | head

# Aus dem API-Container
docker compose exec api wget -qO- http://127.0.0.1:3000/metrics

# Aus einem anderen Container im internen Netz `backend`
curl -s http://api:3000/metrics
```

### Metrik-Katalog

HTTP-Requests (Middleware misst nach `res.on('finish')`):

| Metrik | Typ | Labels | Bedeutung |
|---|---|---|---|
| `pp_http_requests_total` | Counter | `method`, `route`, `status` | Anzahl Requests |
| `pp_http_request_duration_seconds` | Histogram | `method`, `route`, `status` | Dauer in Sekunden (Buckets 5 ms – 30 s, `_bucket`/`_sum`/`_count`) |

- `route` ist das Express-Route-Pattern inkl. Mount-Prefix, z. B.
  `/api/v1/projects/:projectId/tasks` oder `/api/v1/auth/login` – **niemals**
  die konkrete URL mit IDs (Kardinalitätsschutz).
- Requests ohne Routen-Match (404) laufen gesammelt unter
  `route="unmatched"`.
- `status` ist der HTTP-Statuscode als String (z. B. `"200"`, `"401"`, `"500"`).
- Der Scrape auf `/metrics` selbst wird nicht gezählt (und nicht geloggt).

Outbox (wird bei jedem Scrape frisch aus `outbox_jobs` gelesen):

| Metrik | Typ | Labels | Bedeutung |
|---|---|---|---|
| `pp_outbox_jobs` | Gauge | `status` (`pending`, `processing`, `done`, `failed`) | Anzahl Outbox-Jobs je Status (API und Worker teilen die DB) |

Node-/Prozess-Metriken (`prom-client` `collectDefaultMetrics`, Präfix `pp_`),
u. a.:

| Metrik | Bedeutung |
|---|---|
| `pp_process_cpu_seconds_total` | CPU-Zeit des Prozesses |
| `pp_process_resident_memory_bytes` | RSS |
| `pp_process_start_time_seconds` | Startzeitpunkt |
| `pp_nodejs_eventloop_lag_seconds` (inkl. `_p50`, `_p99`, …) | Event-Loop-Lag |
| `pp_nodejs_heap_size_used_bytes` / `pp_nodejs_heap_size_total_bytes` | Heap |
| `pp_nodejs_gc_duration_seconds` | GC-Dauer (Summary) |
| `pp_nodejs_active_resources_total` | Aktive Handles/Requests |

Die vollständige Liste liefert ein Scrape (`grep '^# HELP pp_'`); die API wird
als einzelne Instanz betrieben, daher sind keine `instance`-Labels gesetzt.

### Beispiel-Scrape-Konfiguration

Prometheus muss `api:3000` erreichen, also dem internen Compose-Netz
`<projektname>_backend` (Standard: `projectplaner_backend`, `internal: true`)
beitreten:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: projectplaner-api
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ["api:3000"]
```

```yaml
# Ausschnitt der Prometheus-Instanz in docker-compose.override.yml
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    networks: [backend]   # zusätzlich ein Netz mit Ausgang/Ingress für UI
```

Hinweise:

- Das Netz `backend` ist `internal: true` – Prometheus braucht ein zweites
  Netz (z. B. `edge` oder ein eigenes), um selbst erreichbar zu sein.
- Der Endpunkt hat **keine** Authentifizierung; er darf nur intern erreichbar
  sein (siehe unten).

### Empfohlene Alarme (Beispiele)

```yaml
- alert: ApiDown
  expr: up{job="projectplaner-api"} == 0
  for: 2m
- alert: Api5xx
  expr: rate(pp_http_requests_total{status=~"5.."}[5m]) > 0
  for: 5m
- alert: OutboxJobsFailed
  expr: pp_outbox_jobs{status="failed"} > 0
  for: 10m
- alert: EventLoopLag
  expr: pp_nodejs_eventloop_lag_p99_seconds > 0.5
  for: 10m
```

## Logs

- API und Worker schreiben strukturierte **pino-JSON-Logs** nach stdout;
  in Dev formatiert `pino-pretty` sie lesbar (`LOG_LEVEL` steuert die Stufe).
- Der Compose-Logging-Driver `json-file` rotiert mit `max-size: 10m` und
  `max-file: 5` (siehe `x-logging` in `docker-compose.yml`).
- Ansehen: `docker compose logs -f api worker`; Requests tragen eine
  `x-request-id` (bzw. generierte UUID) zur Korrelation.
- `/healthz`, `/readyz` und `/metrics` werden nicht geloggt, um Scrape- und
  Healthcheck-Rauschen zu vermeiden.
- Ein zentraler Log-Stack (z. B. Loki/ELK) ist optional und nicht Teil des
  Compose-Stacks.

## Backup

- Tägliches `mysqldump` über den `backup`-Service (14 Tage Aufbewahrung) und
  der monatliche Restore-Drill sind in `docs/operations/backup-restore.md`
  beschrieben.
- `APP_ENCRYPTION_KEY` und `JWT_SECRET` separat sichern; ohne sie sind
  Outlook-Tokens nach einem Restore unlesbar bzw. alle Sessions ungültig.

## In Produktion nicht öffentlich

`/metrics` ist bewusst **nicht** öffentlich:

- Im Caddyfile (`deploy/Caddyfile`) werden nur `/healthz`, `/api/*` und
  `/socket.io/*` behandelt; `/metrics` fällt in den SPA-Handler und liefert
  damit `index.html` statt Metriken.
- Der API-Port 3000 wird im Compose-Stack nicht nach außen veröffentlicht
  (nur der `web`-Service mappt 80/443).
- Prüfen: `curl -s https://$DOMAIN/metrics | head` → HTML der SPA, keine
  `pp_`-Metriken.

Zusätzliche Absicherung (optional, nicht im Repo verdrahtet):

1. **Caddy-Block**: `/metrics` explizit mit `respond 404` beantworten
   (verteidigt gegen spätere Umbauten der Routen).
2. **Firewall/Security-Group**: Port 3000 nur aus dem internen Netz erlauben.
3. **Scrape nur intern**: Prometheus ausschließlich am Netz `backend`
   betreiben; den Endpunkt hinter keinem öffentlichen Ingress terminieren.
4. Metriken enthalten interne Informationen (Routen, Outbox-Zustand, Speicher,
   Node-Version) – keine Secrets, aber auch nicht für Dritte bestimmt.
