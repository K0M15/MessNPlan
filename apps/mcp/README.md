# @projectplaner/mcp

MCP-Server (Model Context Protocol) für ProjectPlaner. Stellt Projekte, Aufgaben,
Abhängigkeiten, Ressourcen-Zuteilungen, Planungslauf und Planungsprüfung als
MCP-Tools bereit – lokal über **stdio**, remote über **Streamable HTTP** mit
**SSH-Key-Authentifizierung**.

Der Server spricht ausschließlich mit der ProjectPlaner-REST-API unter `/api/v1`
(kein direkter DB-Zugriff, keine duplizierte Fachlogik).

## Installation & Build

```bash
# im Repo-Root
npm install
npm run build -w @projectplaner/shared
npm run build -w @projectplaner/mcp

# Start (stdio)
node apps/mcp/dist/index.js

# Start (HTTP)
node apps/mcp/dist/index.js --http --port 3900
```

Über die `bin`-Verbindung nach `npm install`/`npm link`:

```bash
projectplaner-mcp            # stdio
projectplaner-mcp --http --port 3900
```

## Zugriffswege (Auth-Modus)

| Modus | Env | Kann | Hinweis |
|---|---|---|---|
| **REST-Session** | `PP_EMAIL` + `PP_PASSWORD` | lesen **und** schreiben | Service-Account (Admin/Planner/Member je nach Rolle) |
| **SSH-signiert** | `PP_KEY_ID` + `PP_PRIVATE_KEY_PATH` | nur anlegen | externe API `/api/v1/external`; Lesen ist dort nicht möglich |

Sind beide konfiguriert, gewinnt REST. Ein SSH-Schlüssel ist an ein Projekt
gebunden; `PP_PROJECT_ID` prüft das zusätzlich vor dem Request (optional).

## Umgebungsvariablen

| Variable | Pflicht | Default | Bedeutung |
|---|---|---|---|
| `PP_API_URL` | nein | `http://localhost:3000` | Basis-URL der API (ohne Pfad) |
| `PP_EMAIL` / `PP_PASSWORD` | für REST | – | Service-Login |
| `PP_KEY_ID` | für SSH | – | ID des API-Schlüssels (`x-pp-key-id`) |
| `PP_PRIVATE_KEY_PATH` | für SSH | – | Pfad zum **PKCS#8**-Private-Key |
| `PP_KEY_TYPE` | nein | aus Schlüssel abgeleitet | `ssh-ed25519` oder `ssh-rsa` (Konsistenzprüfung) |
| `PP_PROJECT_ID` | nein | – | Projektbindung des Schlüssels (Frühprüfung) |
| `PP_INTERNAL_URL` | HTTP | `PP_API_URL` | Basis für `/internal/verify-ssh` |
| `PP_INTERNAL_TOKEN` | HTTP | `JWT_SECRET` | Token für interne API-Endpunkte |
| `PP_MCP_HOST` | nein | `0.0.0.0` | Bind-Adresse (`--host` überschreibt) |
| `PP_MCP_PORT` | nein | `3900` | HTTP-Port (`--port` überschreibt) |

Die Konfiguration wird beim Start per Zod validiert; fehlende oder
widersprüchliche Variablen führen zu einer klaren Fehlermeldung.

## stdio-Betrieb

Für Claude Desktop, IDEs und andere MCP-Hosts (Client-Konfigurationen siehe
`docs/MCP.md`):

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

> **Wichtig:** Auf stdout darf nichts anderes als das MCP-Protokoll landen.
> Der Server schreibt Logs/Fehler ausschließlich nach stderr (`console.error`).

## HTTP-Betrieb (Streamable HTTP)

```bash
projectplaner-mcp --http --port 3900 --host 0.0.0.0
```

- MCP-Endpunkt: `POST/GET/DELETE http://<host>:3900/mcp`
- Health: `GET http://<host>:3900/healthz`
- **Jeder** MCP-Request muss mit den drei SSH-Headern signiert sein:
  `x-pp-key-id`, `x-pp-timestamp` (Unix-Sekunden), `x-pp-signature`
  (Base64 über den kanonischen String aus `docs/API-external.md`).
- Die Verifikation läuft über den internen API-Endpunkt `POST /internal/verify-ssh`
  (Token `PP_INTERNAL_TOKEN`/`JWT_SECRET`); der MCP-Server dupliziert die
  Signaturlogik nicht.

### Beispiel: signierter Streamable-HTTP-Client (Node)

Schlüsselpaar anlegen und administrativ hinterlegen (siehe
`docs/API-external.md`), danach den OpenSSH-Key einmalig nach PKCS#8 kopieren:

```bash
ssh-keygen -t ed25519 -C "mcp-remote" -f pp_mcp_key -N ""
cp pp_mcp_key pp_mcp_key.pem
ssh-keygen -p -N "" -m PKCS8 -f pp_mcp_key.pem
```

```js
// mcp-signed-client.mjs – signiert jeden MCP-Request
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const KEY_ID = Number(process.env.PP_KEY_ID);             // z. B. 7
const privateKey = createPrivateKey(readFileSync(process.env.PP_PRIVATE_KEY_PATH));

/** fetch-Wrapper, der den kanonischen String des Requests signiert. */
function signedFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : '';
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = [
    String(KEY_ID),
    String(timestamp),
    method,
    url.pathname + url.search,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

  const headers = new Headers(init.headers);
  headers.set('x-pp-key-id', String(KEY_ID));
  headers.set('x-pp-timestamp', String(timestamp));
  headers.set('x-pp-signature', signature);
  return fetch(url, { ...init, headers });
}

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3900/mcp'), {
  fetch: signedFetch,
});
const client = new Client({ name: 'projectplaner-cli', version: '1.0.0' });
await client.connect(transport);

console.log(await client.listTools());
console.log(await client.callTool({ name: 'list_projects', arguments: {} }));
await client.close();
```

Hinweis: Standard-MCP-Clients, die keine dynamischen Header unterstützen,
können den HTTP-Endpunkt nicht direkt nutzen – dort den stdio-Modus verwenden
oder den obigen signierten Client als Brücke einsetzen.

## Tools

| Tool | Zweck | Lesen/Schreiben |
|---|---|---|
| `list_projects` | sichtbare Projekte | lesen |
| `get_project` | Projekt + Mitglieder + Aufgaben + Ressourcen | lesen |
| `list_tasks` | Aufgabenbaum/flach, Filter (Status, Eltern, Ressource, Suche) | lesen |
| `create_task` | Aufgabe/Unteraufgabe anlegen (Schätzung, Constraint, Meilenstein) | schreiben |
| `add_dependency` | FS/SS/FF/SF + Lag | schreiben |
| `assign_resource` | Ressource mit Auslastung zuteilen | schreiben |
| `compute_schedule` | CPM-Neuberechnung anstoßen | schreiben |
| `get_health` | „fertig geplant"-Findings | lesen |
| `get_gantt_summary` | Zeitraum, kritische Aufgaben, Auslastungsspitzen | lesen |

Alle Antworten sind kompakte JSON-Strings; große Listen werden mit
`truncated`-Flag gekürzt.

## Tests

```bash
npm run typecheck -w @projectplaner/mcp
npm test -w @projectplaner/mcp        # 47 Tests (Unit + stdio-Smoke + HTTP)
npm run build -w @projectplaner/mcp
npx eslint apps/mcp
```
