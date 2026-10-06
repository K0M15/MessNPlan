# MCP-Server (Model Context Protocol)

Der MCP-Server `apps/mcp` (`@projectplaner/mcp`) verbindet MCP-fähige
Assistenten (Claude Desktop, Claude Code, IDEs, eigene Clients) mit
ProjectPlaner. Er arbeitet ausschließlich über die REST-API `/api/v1` – es gibt
keinen direkten Datenbankzugriff und keine duplizierte Fachlogik.

- **stdio** (Standard): lokale Clients starten den Prozess selbst.
- **Streamable HTTP** (`--http`): remote erreichbarer MCP-Endpunkt unter
  `/mcp`, geschützt durch **SSH-Signaturen** (dieselben Header und derselbe
  kanonische String wie in [API-external.md](./API-external.md)).

## 1. Architektur

```
MCP-Client ──stdio──────────────────┐
MCP-Client ──HTTPS + SSH-Signatur──▶ MCP-Server (apps/mcp)
                                     │  Service-Login (pp_at/pp_rt)
                                     ▼
                              ProjectPlaner-API /api/v1
                                     ▲
                       POST /internal/verify-ssh (Token = JWT_SECRET)
```

- **Zugriffswege** (austauschbares `TaskApi`-Interface):
  - `RestSessionApi`: Service-Login (`PP_EMAIL`/`PP_PASSWORD`) mit
    serverseitigem Cookie-Handling (`pp_at`/`pp_rt`) und single-flight
    401-Refresh; kann lesen und schreiben.
  - `SshSignedApi`: signierte externe API (`/api/v1/external`); kann nur
    Aufgabe, Abhängigkeit und Zuteilung **anlegen**. Lesende Tools melden
    einen klaren Fehler.
- **HTTP-Verifikation ohne Duplikat:** Der MCP-Server reicht Header und rohen
  Body eingehender Requests an `POST /internal/verify-ssh` der API weiter
  (gleiches Token-Verfahren wie `/internal/broadcast`). Key-Lookup,
  Aktiv-/Ablaufprüfung, Replay-Fenster (±300 s) und Signaturprüfung bleiben in
  `apps/api/src/http/sshAuth.ts` (`authenticateSshRequest`).
- **Session- und Projektbindung:** Aus der Verify-Antwort übernimmt der
  MCP-Server Projekt und Schlüsselname und bindet die `mcp-session-id` an den
  verifizierten Schlüssel – Requests mit fremder Session-ID werden mit `403`
  abgewiesen, unbekannte oder abgelaufene Sessions mit `404`. Die
  Projektbindung des Schlüssels wird in der Tool-Schicht erzwungen
  (`projectId`-Prüfung/-Vorbelegung, gefiltertes `list_projects`).
- **Schutz am Endpunkt:** In-Memory-Rate-Limit von 60 Requests/Minute je
  Schlüssel (`429` + `Retry-After`) und Idle-Timeout von 30 Minuten je
  Session.

## 2. Client-Konfiguration

### Claude Desktop (stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "projectplaner": {
      "command": "node",
      "args": ["/pfad/zu/ProjectPlaner/apps/mcp/dist/index.js"],
      "env": {
        "PP_API_URL": "http://localhost:3000",
        "PP_EMAIL": "mcp-bot@example.com",
        "PP_PASSWORD": "…"
      }
    }
  }
}
```

Voraussetzung: `npm run build -w @projectplaner/mcp` (erzeugt
`apps/mcp/dist/index.js`). Wer `tsx` zur Hand hat, kann auch direkt
`node --import tsx /pfad/.../apps/mcp/src/index.ts` verwenden.

### IDE / generische MCP-Hosts (stdio)

Viele IDEs (VS Code/Copilot, Cursor, Windsurf, Cline) nutzen `mcp.json` mit
demselben Schema:

```json
{
  "mcpServers": {
    "projectplaner": {
      "command": "node",
      "args": ["/pfad/zu/ProjectPlaner/apps/mcp/dist/index.js"],
      "env": { "PP_API_URL": "http://localhost:3000", "PP_EMAIL": "…", "PP_PASSWORD": "…" }
    }
  }
}
```

### Remote (Streamable HTTP mit SSH-Signatur)

Server starten (auf der Maschine, die auch die API erreicht):

```bash
PP_EMAIL=mcp-bot@example.com PP_PASSWORD=… PP_INTERNAL_TOKEN=… \
  projectplaner-mcp --http --port 3900 --host 0.0.0.0
```

Da MCP-Standardclients keine dynamisch signierten Header erzeugen, wird ein
kleiner signierender `fetch`-Wrapper benötigt (vollständiges Beispiel in
[apps/mcp/README.md](../apps/mcp/README.md)):

```js
const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example/mcp'), {
  fetch: signedFetch, // signiert x-pp-key-id/x-pp-timestamp/x-pp-signature pro Request
});
```

Betriebsempfehlungen:

- Vor der Öffentlichkeit einen Reverse Proxy mit TLS setzen und nur `/mcp`
  veröffentlichen (der Server selbst spricht HTTP).
- `PP_INTERNAL_TOKEN` sollte ein eigener Wert sein; ohne Angabe wird
  `JWT_SECRET` verwendet.
- `PP_MCP_HOST=127.0.0.1` verwenden, wenn der Endpunkt über einen lokalen
  Reverse Proxy läuft.

## 3. Umgebungsvariablen

| Variable | Pflicht | Default | Bedeutung |
|---|---|---|---|
| `PP_API_URL` | nein | `http://localhost:3000` | Basis-URL der REST-API |
| `PP_EMAIL` / `PP_PASSWORD` | für REST-Session | – | Service-Login |
| `PP_KEY_ID` / `PP_PRIVATE_KEY_PATH` | für SSH-Modus | – | ID und PKCS#8-Key der externen API |
| `PP_KEY_TYPE` | nein | abgeleitet | `ssh-ed25519` \| `ssh-rsa` |
| `PP_PROJECT_ID` | nein | – | Projektbindung des SSH-Schlüssels prüfen |
| `PP_INTERNAL_URL` | nein | `PP_API_URL` | API-Basis für `/internal/verify-ssh` |
| `PP_INTERNAL_TOKEN` | HTTP-Pflicht | `JWT_SECRET` | Token der internen Endpunkte |
| `PP_MCP_HOST` / `PP_MCP_PORT` | nein | `0.0.0.0` / `3900` | Bind-Adresse/Port (CLI-Flags gewinnen) |

Start-CLI: `projectplaner-mcp [--http] [--port <n>] [--host <h>]`; `--help`
listet alles auf.

## 4. Tool-Katalog

Alle Eingaben werden per Zod validiert; Antworten sind kompakte JSON-Strings.
Listen sind gekürzt (`truncated`-Flag), sofern nicht anders angegeben.

| Tool | Eingaben | Ausgabe |
|---|---|---|
| `list_projects` | – | `{ projects: [{ id, name, status, timezone, myRole }] }` |
| `get_project` | `projectId` | Projekt (inkl. Kalender/Version), Mitglieder, kompakte Aufgabenliste (max. 500), Ressourcen |
| `list_tasks` | `projectId`, `tree?` (Default true), `status?`, `parentId?`, `resourceId?`, `query?`, `limit?` (Default 200, max. 2000) | `{ mode, totalCount, returned, truncated, items }`; im Baum bleiben Eltern von Treffern enthalten |
| `create_task` | `projectId`, `name`, `parentId?`, `description?`, `estimatedMinutes?`, `isMilestone?`, `status?`, `priority?`, `constraintType?`, `constraintDate?` | `{ task: { …kompakt } }` |
| `add_dependency` | `projectId`, `predecessorId`, `successorId`, `type?` (FS/SS/FF/SF), `lagMinutes?` | `{ dependency: { … } }` |
| `assign_resource` | `projectId`, `taskId`, `resourceId`, `allocationPercent?` (1–400, Default 100) | `{ assignment: { … } }` |
| `compute_schedule` | `projectId` | `{ result: { projectId, version, taskCount, cyclicCount, computedAt } }` |
| `get_health` | `projectId`, `severity?`, `limit?` (Default 100) | `{ summary, totalCount, truncated, issues }` |
| `get_gantt_summary` | `projectId`, `from?`, `to?` (ISO-8601) | `{ project, scheduleVersion, taskCount, milestoneCount, scheduled/unscheduled/criticalTaskCount, edge/resource/assignmentCount, earliestStart, latestEnd, utilization }` |

Die Schreib-Tools nutzen im REST-Modus die **internen** Endpunkte
(`POST /projects/{id}/tasks`, `POST /tasks/{id}/dependencies`,
`POST /tasks/{id}/assignments`) und im SSH-Modus die externen Endpunkte
(`POST /api/v1/external/...`).

Bei projektgebundenen HTTP-Schlüsseln (Streamable HTTP) ist der Parameter
`projectId` optional: Er wird auf das Projekt des verifizierten Schlüssels
vorbelegt; eine abweichende Projekt-ID lehnt das Tool mit einem Fehler ab.
`list_projects` liefert dann ausschließlich dieses Projekt.

## 5. Sicherheitsmodell

- **MCP-HTTP-Endpunkt:** Jeder Request (auch GET/DELETE/Session-Ende) ist mit
  `x-pp-key-id`, `x-pp-timestamp`, `x-pp-signature` zu signieren. Gültige
  Schlüssel sind projektgebundene API-Schlüssel aus der Schlüsselverwaltung
  (Web-UI → Projekteinstellungen → API-Schlüssel). Private Keys verlassen den
  Client nie.
- **Replay-Schutz:** Timestamps werden nur im ±300-s-Fenster akzeptiert;
  Uhren per NTP synchron halten. Bei Verbindungsabbrüchen einen frisch
  signierten Request neu senden (nicht denselben recyceln).
- **Interner Endpunkt:** `/internal/verify-ssh` und `/internal/broadcast` sind
  nicht öffentlich (Caddy leitet nur `/api/*` und `/socket.io/*` weiter) und
  verlangen das Token `PP_INTERNAL_TOKEN`/`JWT_SECRET`. Der MCP-Server gibt
  Header/URL/Body durch und cached keine Ergebnisse.
- **Service-Account:** Für Lese-Tools hält der MCP-Server eigene
  API-Zugangsdaten (`PP_EMAIL`/`PP_PASSWORD`). Ein dediziertes Konto mit
  minimal nötiger Rolle (z. B. `planner` nur in den relevanten Projekten)
  verwenden; das Konto kann in der Admin-UI deaktiviert werden.
- **Session-Bindung:** Die `mcp-session-id` ist an den API-Schlüssel gebunden,
  der sie initialisiert hat. Ein anderer gültiger Schlüssel erhält `403`,
  unbekannte/abgelaufene Sessions `404`. Sessions verfallen nach 30 Minuten
  ohne Request; ein In-Memory-Rate-Limit von 60 Requests/Minute je Schlüssel
  beantwortet Übermaß mit `429` und `Retry-After`.
- **Body-Limit:** Der MCP-HTTP-Endpunkt nimmt maximal **4 MiB** pro Request an
  und lehnt größere mit `413 Payload Too Large` ab. Der interne
  Verify-Endpunkt der API ist für den base64-kodierten Body mit **8 MB**
  JSON-Limit konfiguriert (+33 % Base64-Overhead), alle übrigen API-Routen
  bleiben bei **1 MB** – wirksam für Clients ist damit das 4-MiB-Limit.
- **Sichtbarkeit:** Der HTTP-Endpunkt authentifiziert den Client per
  API-Schlüssel und beschränkt ihn auf das Projekt des Schlüssels (Tools
  erzwingen die Projekt-ID). Die fachliche Berechtigung (Rolle im Projekt)
  folgt zusätzlich aus dem Service-Konto; für getrennte Sichten je
  Aufrufergruppe weiterhin eine eigene MCP-Instanz mit eigenem Konto
  betreiben.
- **Keine DB-Duplikate:** Validierung/Fachregeln (Zyklen, Constraints,
  Duplikate, Rate-Limits) bleiben in der API; der MCP-Server reicht
  Fehler als Tool-Fehler mit HTTP-Status und Detailtext zurück.
- **Empfehlung Produktion:** TLS über Reverse Proxy, enger Netzwerkzugriff,
  `PP_MCP_HOST` restriktiv setzen, Schlüssel mit `expiresAt` versehen und
  regelmäßig rotieren (`lastUsedAt` beobachten).

## 6. Tests

```bash
npm run typecheck -w @projectplaner/mcp
npm test -w @projectplaner/mcp          # Unit + stdio-Smoke + HTTP-Transport
npm run build -w @projectplaner/mcp
npx eslint apps/mcp
```

Abgedeckt: Env-Validierung, REST-Session inkl. 401-Refresh (Fetch-Mock),
SSH-Signatur (Ed25519/RSA gegen Test-Keys), Tool-Handler gegen Mock-API
inklusive Projektbindung, `tools/list` über stdio-Subprozess und über
signierten Streamable-HTTP-Client sowie 401/403/404/405/429-Verhalten des
HTTP-Endpunkts (Session-/Key-Bindung, Idle-Timeout, Rate-Limit). Auf API-Seite
prüft `external-api.integration.test.ts` den Verify-Endpunkt (gültig, falsche
Signatur, URL-Bindung, Token-/Payload-Fehler).
