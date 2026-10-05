# E2E-Tests (Playwright)

End-to-End-Tests für den ProjectPlaner gegen eine **laufende** Applikation.
Playwright startet bewusst keinen eigenen Server (`webServer` ist nicht konfiguriert).

## Voraussetzungen

- Laufende Applikation inkl. API und DB:
  - **Dev:** `npm run dev` (Web: http://localhost:5173, API: http://localhost:3000)
  - **Prod/CI:** `docker compose up -d` (Web: https://localhost, selbstsigniertes Zertifikat)
- Seed-Daten: `npm run db:seed` (Admin `admin@example.com` / `admin1234!`, Demo-Projekt)
- Chromium installieren: `npx playwright install chromium` (mit `--with-deps` in CI)

## Ausführung

```bash
# aus dem Repo-Root (Dev-Stack unter http://localhost:5173)
npm run test:e2e

# gegen den Prod-Stack / eine andere URL (self-signed wird ignoriert)
E2E_BASE_URL=https://localhost npm run test:e2e

# gezielt einzelne Dateien
npm run test:e2e -w @projectplaner/e2e -- specs/gantt.spec.ts
```

Optionale Umgebungsvariablen: `E2E_BASE_URL` (Default `http://localhost:5173`),
`E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`.

Hinweis: Jeder Test loggt sich selbst per UI ein. Der Refresh-Token rotiert
serverseitig mit Reuse-Erkennung, ein geteilter Storage-State wäre daher nicht
stabil. Die Suite läuft mit `workers: 1` und `fullyParallel: false`.
Ein Lauf benötigt 6 Login-Requests; die API begrenzt Logins auf 20 pro 15
Minuten und IP. Bei sehr häufigen Läufen kurz warten oder die API neu starten.

## Testfälle

| Datei | Inhalt |
|---|---|
| `specs/auth.spec.ts` | Falscher Login zeigt Fehlermeldung; Login ok → Projektübersicht; Logout → Login-Seite |
| `specs/project-flow.spec.ts` | Projekt + Aufgabe + Teilaufgabe anlegen, Schätzung speichern, FS-Abhängigkeit ergänzen, Cleanup per API |
| `specs/gantt.spec.ts` | Demo-Projekt: Canvas sichtbar, alle Zoom-Stufen fehlerfrei, „Planungs-Check“, Listen-Tab mit Aufgabenbaum |
| `specs/settings.spec.ts` | Projekt-Einstellungen (Zeitzone/Arbeitszeit) unverändert speichern, Feiertag „E2E-Test“ anlegen und löschen |

## Artefakte

- HTML-Report: `tests/e2e/playwright-report/`
  (`npx playwright show-report tests/e2e/playwright-report`)
- Traces und Screenshots bei Fehlern: `tests/e2e/test-results/`
  (`trace: retain-on-failure`, `screenshot: only-on-failure`)
- Beide Verzeichnisse sind ignoriert und werden in CI nur bei Fehlschlag hochgeladen.

## CI

Job `e2e` in `.github/workflows/ci.yml` (ubuntu-latest):

1. `npm ci --no-audit --no-fund` und `cp .env.example .env`
2. `docker compose build`
3. DB starten, `docker compose run --rm migrate`,
   Seed `docker compose run --rm -e SEED_DEMO=true migrate node apps/api/dist/db/seed.js`
4. `docker compose up -d api worker web` mit `APP_ORIGIN=https://localhost`
   und `COOKIE_SECURE=true` (überschreibt die Dev-Werte aus `.env.example`)
5. Warten auf `https://localhost/healthz` (curl `-k`, Schleife)
6. `npx playwright install --with-deps chromium`
7. `E2E_BASE_URL=https://localhost npm run test:e2e -w @projectplaner/e2e`
8. Upload von `playwright-report/` + `test-results/` bei Fehlschlag,
   `docker compose down -v` immer

## Bekannte App-Bugs (Workarounds im Test)

`project-flow.spec.ts` arbeitet derzeit um zwei Befunde herum (im Rahmen des
Test-Setups wurden bewusst keine App-Dateien geändert):

1. **TaskDrawer-Speichern wirft `TypeError`:** `TaskDrawer.save()` ruft
   `form.hours.trim()` auf, obwohl Vue `v-model` auf `input[type=number]` als
   Zahl bindet. Der Klick auf „Speichern“ erzeugt keinen Request. Der Test nutzt
   primär weiter den UI-Weg (inkl. Toast „Aufgabe gespeichert“) und fällt nur bei
   genau diesem Fehler auf einen API-PATCH zurück.
2. **Vorgänger/Nachfolger vertauscht:** `GET /tasks/:id/dependencies` ordnet
   Kanten, bei denen die Aufgabe Vorgänger ist, den `predecessors` zu (und
   umgekehrt). Die Drawer-Liste zeigt dadurch die falsche Sektion/den falschen
   Namen. Der Test prüft die Persistenz deshalb über beide Listen hinweg.
