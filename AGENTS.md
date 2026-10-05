# AGENTS.md — ProjectPlaner

> Kurzreferenz für Sessions/Agenten. **Am Ende jeder Session Abschnitte 10–12 aktualisieren.**

## 1. Zweck

Webbasierte Projektplanungs-App („ProjectPlaner"): Aufgaben mit Subaufgaben, Zeitschätzung,
Abhängigkeiten (FS/SS/FF/SF + Lag), Ressourcenplanung (Menschen/Maschinen), Gantt mit Zoom von
Stunden bis Quartalen inkl. Ressourcen-Auslastungszeilen, Kommentare/Tags, „fertig geplant"-Check
und automatischer, delegierter Outlook-Kalender-Sync (Microsoft Graph).

## 2. Stack & Versionen

| Bereich | Technologie |
|---|---|
| DB | MySQL 8.4 LTS (utf8mb4, UTC) |
| API | Node 24 (Container) / Node >= 22 (Host), TypeScript strict, Express 5 |
| ORM | Drizzle ORM + mysql2 + drizzle-kit (Migrationen als SQL) |
| Auth | Lokale Konten, Argon2id (`@node-rs/argon2`), JWT Access/Refresh in httpOnly-Cookies |
| Realtime | Socket.IO (Rooms je Projekt, Presence, Live-Updates) |
| Scheduling | Eigenbau-CPM mit Arbeitskalender (Luxon, Projekt-Zeitzone) |
| Web | Vue 3, Vite, Pinia, Vue Router, Tailwind CSS, socket.io-client |
| Gantt | Eigenentwicklung: Canvas-Rendering, virtualisierte Zeilen, Drag-Pins |
| Edge | Caddy 2 (SPA + automatisches TLS + Reverse Proxy) |
| Tests | Vitest, Supertest, Testcontainers(MySQL, geplant), Playwright (geplant) |
| CI | GitHub Actions (Lint, Types, Tests, Build, Compose-Smoke-Test) |

## 3. Schnellstart

**Dev (empfohlen, Hot Reload auf dem Host):**
```bash
cp .env.example .env        # Werte anpassen
npm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
npm run db:migrate
npm run db:seed
npm run dev                 # shared-Watch + API :3000 + Worker + Web :5173
```

**Dev komplett in Containern (Hot Reload):**
```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

**Prod:**
```bash
cp .env.example .env        # sichere Secrets setzen! APP_ENCRYPTION_KEY, JWT_SECRET, COOKIE_SECURE=true, APP_ORIGIN/DOMAIN
docker compose up -d --build
```

## 4. Wichtige Befehle

| Befehl | Wirkung |
|---|---|
| `npm run dev` | shared-Watch + API (tsx watch) + Worker + Web (Vite) |
| `npm run build` | shared → api → web bauen |
| `npm run typecheck` | TypeScript-Prüfung aller Workspaces |
| `npm test` | Unit-Tests (Vitest) |
| `npm run test:integration` | API-Integrationstests (Testcontainers-MySQL, ~20 s) |
| `npm run test:e2e` | Playwright-E2E (laufende App unter `E2E_BASE_URL` nötig) |
| `npm run lint` | ESLint über das Repo |
| `npm run db:generate` | Drizzle-Migration aus Schema generieren (nach Schemaänderung!) |
| `npm run db:migrate` | Migrationen anwenden |
| `npm run db:seed` | Admin + Demo-Daten (idempotent) |
| `npm run db:seed:perf -w @projectplaner/api -- --tasks 2000 --resources 30 [--clean]` | Lasttest-Projekt „Perf-Test" |
| `docker compose config` | Compose-Datei validieren |
| `scripts/backup.sh` / `scripts/restore.sh <dump>` | MySQL-Backup / Restore |

## 5. URLs, Ports, Logins

| Umgebung | URL | Ports |
|---|---|---|
| Dev (Host) | Web http://localhost:5173, API http://localhost:3000 | 5173, 3000, 3306 (nur mit dev-Compose) |
| Prod | https://$DOMAIN (Caddy) | 80, 443 |

Login: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` aus `.env` (Default `admin@example.com` / `admin1234!`).

## 6. Umgebungsvariablen

Siehe `.env.example` (vollständig kommentiert). Pflicht in Prod: `MYSQL_PASSWORD`,
`MYSQL_ROOT_PASSWORD`, `JWT_SECRET` (≥ 32 Zeichen), `COOKIE_SECURE=true`, `APP_ORIGIN`.
Für Outlook-Sync zusätzlich: `APP_ENCRYPTION_KEY` (32 Byte base64) sowie `GRAPH_CLIENT_ID`,
`GRAPH_TENANT_ID`, ggf. `GRAPH_CLIENT_SECRET`, `GRAPH_REDIRECT_URI`.

## 7. Domänenregeln

- **Dauern immer in Minuten** (`estimated_minutes`), Anzeige konvertiert.
- **Zeiten in UTC** in der DB; Anzeige/Planung in `projects.timezone`.
- **Abhängigkeitstypen**: FS (= Standard), SS, FF, SF, jeweils mit `lag_minutes` (auch negativ), Zyklen sind verboten.
- **Constraints**: `asap` (auto), `start_no_earlier_than`, `start_on` — Drag im Gantt erzeugt einen lösbaren Pin (`start_no_earlier_than`); „Pin lösen" im Drawer → zurück zu ASAP.
- **Meilensteine** haben Dauer 0; Elternaufgaben ohne Schätzung erben den Zeitraum ihrer Kinder (Rollup).
- **„Fertig geplant"**: Schätzung, Ressource, kein Zyklus, keine Überbelegung; Katalog in `apps/api/src/services/planningHealth.ts`.
- **Auslastung**: `capacity_minutes_per_day`; Zuteilungen werden gleichmäßig auf Arbeitstage/Arbeitsstunden verteilt (Näherung).
- **Arbeitskalender**: `projects.workweek` (JSON-Array 0=So…6=Sa), `workday_start/end`, `holidays`.

## 8. Architektur & Konventionen

- Monorepo (npm workspaces): `apps/api`, `apps/web`, `packages/shared` (Zod-Schemas + Typen).
- API-Routen unter `/api/v1`; Fehler als RFC 7807 (`application/problem+json`).
- Validierung immer per Zod-Schema aus `@projectplaner/shared`.
- Optimistic Locking: Entitäten mit `version`-Spalte; UI sendet `If-Match` (Version) → bei Konflikt `409`.
- Realtime: Server broadcastet nach Mutationen in `project:{id}`; Events: `schedule:updated`, `task:changed`, `project:changed`, `presence:*`.
- Worker-Prozess verarbeitet `outbox_jobs` (schedule.compute entprellt, outlook.sync) und ruft für Broadcasts den internen Endpoint `POST /internal/broadcast` (Token = `JWT_SECRET`) auf.
- Frontend: API-Zugriffe ausschließlich über `apps/web/src/api/`, zentraler Store `apps/web/src/stores/project.ts`.
- Neue DB-Felder: Schema anpassen → `npm run db:generate` → Migration committen.
- Keine Secrets im Repo; `.env` ist ignoriert.

## 9. DB-/Migrations-Workflow

1. `apps/api/src/db/schema.ts` ändern.
2. `npm run db:generate` → SQL-Datei in `db/migrations/`.
3. Migration reviewen (datenverlustfrei?), `npm run db:migrate`.
4. In Prod läuft `migrate` als eigener Compose-Service vor `api`.

## 10. Status

| Meilenstein | Status |
|---|---|
| M0 Scaffold + Compose + AGENTS.md | ✅ Prod-Stack (Caddy/TLS, Migrate, API, Worker, Backup) lokal verifiziert |
| M1 Datenmodell, Auth, CRUD-API | ✅ 16 Tabellen, Migration, Argon2/JWT-Cookies, RBAC, Optimistic Locking, Seed |
| M2 Scheduling + Health + Realtime | ✅ CPM + Arbeitskalender, Health-Regelkatalog, Auslastung, Outbox-Worker, Socket.IO |
| M3 Vue-Shell + CRUD-UI | ✅ Login, Projekte, Aufgabenbaum, Drawer (Abhängigkeiten/Ressourcen/Tags/Kommentare), Ressourcen-Modal |
| M4 Gantt | ✅ Canvas, Zoom (Stunde–Monat/Alles), Drag-Pins, Resize, Pfeile, kritischer Pfad, Auslastungszeilen. Lasttest offen |
| M5 Health-UI + Kollaboration | ✅ Health-Panel, Live-Sync, Konflikt-Toasts, Presence-Avatare. Fremd-Auswahl-Highlight nur als Event (nicht gerendert) |
| M6 Outlook | 🟡 Code komplett (delegiert/OAuth-PKCE, verschlüsselte Tokens, Outbox-Sync, Termine CRUD, UI). Nicht gegen echten M365-Tenant getestet |
| M7 Production-Härtung | ✅ TLS/Non-Root/Healthchecks/Backups/CI (4 Jobs inkl. Trivy + Integrationstests), Metriken (`/metrics`), Runbooks (Backup/Restore, Monitoring), E2E-Suite. Restore-Drill erfolgreich (2026-10-05) |
| M8 Abnahme | 🟢 Artefakte komplett; offen: Release-Tag/Abnahmeprotokoll (Session-Handoff via AGENTS.md) |

Letzte Änderungen (2026-10-05): Review-Fixes umgesetzt und verifiziert:
- Schema: `null`/`''` für optionale E-Mail/Farbe wird akzeptiert (+ Tests)
- Auth: Single-Flight-Refresh im Client (401 → Refresh → Replay), Socket-Reconnect nach Refresh
- Refresh-Rotation: atomar per Transaktion, Reuse-Erkennung widerruft die gesamte Token-Familie
- Scheduling: Summary-Aufgaben werden zweiphasig aufgerollt (Abhängigkeiten auf Summaries korrekt); Batch-Persistenz per CASE-UPDATE statt N Einzel-Updates
- Kalenderänderungen (Projekt-PATCH, Feiertage, Task-Move) stoßen Neuberechnung an
- Abhängigkeit auf eigene Oberaufgabe wird abgelehnt
- Worker: Recovery verwaister „processing"-Jobs, 4xx-Fehler terminal (keine 8 Retries), Startup-Wartung crasht nicht, Refresh-Token-Pruning
- Outlook: Sync-Jobs werden entprellt; OAuth-State per SameSite=Lax-Nonce-Cookie an den Browser gebunden; sichere Connection-DTOs; HTML-Escaping in Terminbodies
- Härtung: ER_DUP_ENTRY → 409, ungültiges JSON → 400, effektive Arbeitszeitprüfung, Last-Admin-/Selbst-Deaktivierungsschutz, konfigurierbares trust proxy, Assignment-If-Match, Move-Audit, O(n)-Topologie, Index `task_tags(tag_id)`
- UI: Projekt-Zeitzone in allen Datumsanzeigen/-Eingaben (Luxon), Gantt zeichnet bei jeder Schedule-Aktualisierung neu
- Tests: Scheduler-Unit-Tests (Summaries, Kalender, Constraints), Schema-Tests (44 Unit-Tests gesamt)

Wellen 1+2 (2026-10-05), mit Subagenten umgesetzt und reviewt:
- **Integrationstests** (`npm run test:integration`): 16 Tests auf Testcontainers-MySQL (Auth, Refresh-Reuse, RBAC, Baum/Dependencies, If-Match, Scheduling-Rollup, Validierung)
- **Outlook-Unit-Tests**: Graph/Token/Crypto/Escaping mit Fetch-Mock (23 Tests)
- **E2E** (`npm run test:e2e`): 6 Playwright-Tests (Auth, Projekt-/Task-Flow, Gantt, Einstellungen); CI-Job mit Compose-Stack
- **Frontend**: `GET /users/lookup`, Mitglieder-Modal, Projekt-Einstellungen + Feiertage, Admin-Benutzerverwaltung (`/admin/users`), Outlook-Fehlerbanner + `lastError`
- **Metriken**: `pp_http_requests_total`/`pp_http_request_duration_seconds` (Route-Pattern, keine IDs), `pp_outbox_jobs`, Default-Metriken; `/metrics` nur intern
- **Gantt-Skalierung**: Seed-Generator (~2.000 Tasks/30 Ressourcen), linke Liste virtualisiert (7.786 → 1.414 DOM-Knoten), Zoom-Latenz halbiert, Presence-Fremdauswahl sichtbar
- **Kalender-Materialisierung**: Tages-Cache + ms-Arithmetik statt Luxon pro Slot; `GET /gantt` bei 2.000 Tasks von **9,6 s → 0,11–0,33 s**, `POST /schedule` 1,2 s → 0,48 s (kein Eventloop-Block mehr)
- Bugfixes aus den Tests: `resources`/`tags`-Query (ambigous id → 500 auf Projektseite), `TaskDrawer` Schätzung (`.trim()` auf number), `GET /tasks/:id/dependencies` vertauschte Richtungen, Login-Rate-Limit in Development auf 100

## 11. Nächste Schritte

1. **Outlook gegen echten M365-Tenant**: Azure-App registrieren (Redirect `GRAPH_REDIRECT_URI`, delegated `Calendars.ReadWrite`, `offline_access`, `User.Read`), Verbindung testen; danach Inbound (Delta-Query) und Webhooks ergänzen.
2. **Restore-Drill** monatlich nach `docs/operations/backup-restore.md` wiederholen (Erstlauf 2026-10-05: 1 Projekt/12 Tasks/9 Abhängigkeiten erfolgreich wiederhergestellt).
3. Optional: Trivy von Report- auf Blockiermodus stellen, Grafana/Prometheus-Profil ergänzen, `/metrics` per Caddy blocken (bereits nicht exponiert).
4. Release-Tag + Abnahme (M8): Demo-Projekt prüfen, Runbooks verlinken, Version setzen.

## 12. Entscheidungen (ADR-Kurzlog)

| Datum | Entscheidung | Grund |
|---|---|---|
| 2026-10-05 | MySQL/Express/Vue-Monorepo mit Docker Compose | Anforderung |
| 2026-10-05 | Drizzle statt Prisma | SQL-nah, CTEs für Task-Baum/Kapazität, Migrationen als SQL |
| 2026-10-05 | Canvas-Gantt statt Library | Zoom/Drag/Ressourcenzeilen + ~2.000 Tasks |
| 2026-10-05 | Outlook nur delegiert; Maschinen via Funktionspostfach | Kein App-only/Admin-Policy-Aufwand |
| 2026-10-05 | Lokale Auth; Entra-SSO als späteres Backlog | Keine IdP-Abhängigkeit |
| 2026-10-05 | Caddy statt nginx+certbot | Automatisches TLS, SPA+Proxy in einem |
| 2026-10-05 | Luxon für Zeitzonen/Arbeitskalender | Projekt-Zeitzonen korrekt, gut testbar |
| 2026-10-05 | Broadcast aus Worker über internen HTTP-Endpoint | Kein Redis nötig (eine API-Instanz) |
| 2026-10-05 | Outbox + Debounce für schedule.compute | Stabile Neuberechnung ohne Request-Blockade |
| 2026-10-05 | Refresh-Rotation atomar + Reuse-Erkennung (Familien-Widerruf) | Token-Diebstahl erkennbar, Race ausgeschlossen |
| 2026-10-05 | OAuth-State per Nonce-Cookie an Browser gebunden | Account-Linking-CSRF verhindert |
| 2026-10-05 | Summary-Rollup zweiphasig im Vorwärtspass | Abhängigkeiten auf Oberaufgaben korrekt |
| 2026-10-05 | CASE-Batch-UPDATE bei Plan-Persistenz | ~2.000 Aufgaben ohne N Einzel-Updates |
| 2026-10-05 | 4xx-Fehler beenden Outbox-Jobs sofort | Kein Retry-Rauschen bei gelöschten Projekten |
| 2026-10-05 | Kalender-Tage werden für heiße Pfade materialisiert (Binärsuche statt Luxon pro Slot) | `GET /gantt` 9,6 s → 0,3 s bei 2.000 Tasks, kein Eventloop-Block |
| 2026-10-05 | Testpyramide in CI: Unit + Integration (Testcontainers) + E2E (Playwright) + Trivy | Regressionen früh erkennen, Prod-Images prüfen |
| 2026-10-05 | Login-Rate-Limit in Development 100, in Produktion 20 | E2E-Serienläufe ohne Fehlalarme |

## 13. Bekannte Stolperfallen

- **Dev-DB-Port**: 3306 wird nur mit `-f docker-compose.dev.yml` veröffentlicht; dort ist `backend.internal=false` gesetzt, sonst greifen Portfreigaben nicht.
- **Hostnamen**: In Containern `DATABASE_URL` mit Host `db` (setzt Compose); auf dem Host `localhost` (`.env`).
- **`APP_ENCRYPTION_KEY` rotieren** macht gespeicherte Outlook-Tokens unlesbar → betroffene Ressourcen neu verbinden.
- **Migrationen** werden zur Laufzeit gesucht (`db/migrations`, `apps/api/db/migrations` oder `MIGRATIONS_DIR`).
- **Socket.IO-Auth** nutzt das Access-Cookie (15 min); nach Ablauf verbindet der Socket erst nach Seiten-Reload wieder sauber.
- **Worker** muss bei neuen Job-Typen mitlaufen (`npm run dev` startet ihn mit; in Produktion als eigener Container).
- **CI-Compose-Smoke-Test** braucht `.env` aus `.env.example` (Pflichtvariablen sind dort gesetzt).
- **Passwörter in `.env` nach DB-Init geändert?** MySQL übernimmt `MYSQL_PASSWORD` nur beim ersten Anlegen des Volumes. Danach müssen die DB-Benutzer manuell angepasst werden (`ALTER USER 'planer'@'%' IDENTIFIED BY '…';` plus `root`), sonst schlagen API/Worker mit `ER_ACCESS_DENIED_ERROR` fehl. `DATABASE_URL` muss URL-encodiert mitziehen.
- **Lasttest-Projekt** `Perf-Test` (Seed `db:seed:perf`) bleibt in der Dev-DB; mit `--clean` entfernen. Die deaktivierten Nutzer „Lookup Testnutzer“/„Presence Tester“ können für UI-Tests wieder aktiviert werden.
- **Login-Rate-Limit**: 20/15 min pro IP in Produktion, 100 in Development (E2E). Bei 429 im Dev: kurz warten oder API neu starten.
- **Socket.IO nach Token-Ablauf**: Der Client reconnectet nach einem erfolgreichen Refresh automatisch (`pp:auth-refreshed`).
- **Öffentliche API-Routen müssen in `app.ts` VOR den `/`-gemounteten Sammlern stehen** (`outlookRoutes` vor `taskRoutes` & Co.): Diese Sammel-Router setzen intern `router.use(requireAuth)` und fangen sonst jeden `/api/v1/*`-Request ab. Betroffen ist besonders der Outlook-OAuth-Callback – Microsoft leitet cross-site zurück, dabei werden `SameSite=Strict`-Cookies (Access-Token) nicht gesendet. Gates in Routen mit gemischten Pfaden auf ihre Präfixe beschränken (`router.use(['/integrations/outlook', '/projects/:projectId/outlook'], requireAuth)`). Regressionstest: `apps/api/src/__tests__/integration/outlook.integration.test.ts`.
