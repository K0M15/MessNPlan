# ProjectPlaner

Webbasierte Projektplanung mit Gantt-Diagramm, Ressourcenplanung und Outlook-Kalender-Sync.
Stack: **MySQL 8 · Express 5 · Vue 3**, containerisiert mit **Docker Compose**, TLS via Caddy.

## Schnellstart (Entwicklung)

```bash
cp .env.example .env          # Werte anpassen (Secrets!)
npm install

# Datenbank starten
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db

# Schema + Demo-Daten
npm run db:migrate
npm run db:seed

# API (:3000), Worker, Web (:5173) mit Hot Reload
npm run dev
```

Login: `admin@example.com` / `admin1234!` (aus `.env`: `SEED_ADMIN_*`).

## Produktion

```bash
cp .env.example .env          # sichere Secrets setzen, DOMAIN + APP_ORIGIN anpassen
docker compose up -d --build
```

- Web/SPA + API laufen über Caddy mit automatischem TLS (`DOMAIN`).
- Migrationen laufen als eigener `migrate`-Service vor dem API-Start.
- Backups: täglicher `mysqldump` im `backup`-Service (`backups/`, 14 Tage Retention).

## Wichtige Befehle

| Befehl | Wirkung |
|---|---|
| `npm run dev` | shared + API + Worker + Web mit Hot Reload |
| `npm test` | Unit-Tests (Vitest) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run db:generate` | Migration aus Schema generieren |
| `npm run db:migrate` / `npm run db:seed` | Migrationen / Seed |
| `scripts/backup.sh` / `scripts/restore.sh <dump>` | Backup / Restore |

Details für Agenten und Session-Übergabe: [AGENTS.md](./AGENTS.md).
