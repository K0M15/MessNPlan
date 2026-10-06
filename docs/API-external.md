# Externe API (SSH-signiert)

Die externe API erlaubt Maschinen (Skripte, CI-Jobs, Integrationen), Aufgaben,
Unteraufgaben, Abhängigkeiten und Ressourcen-Zuteilungen anzulegen – ohne
Browser-Session. Die Authentifizierung erfolgt mit **SSH-Schlüsselpaaren**:
Pro Projekt verwaltet ein Planner/Admin öffentliche Schlüssel (Ed25519 oder
RSA); der private Schlüssel bleibt beim Client und signiert jede Anfrage.

Basis-URL: `https://<domain>/api/v1/external`

> Hinweis: Diese API ist derzeit auf **Anlegen** (POST) beschränkt. Änderungen
> und Löschungen laufen weiterhin über die Web-UI bzw. die interne API.

## 1. Schlüssel anlegen (Admin)

Schlüsselpaar erzeugen (Beispiel Ed25519):

```bash
ssh-keygen -t ed25519 -C "ci@example" -f pp_api_key -N ""
# Fingerprint zur Kontrolle:
ssh-keygen -lf pp_api_key.pub
# -> 256 SHA256:AbCdEf… ci@example (ED25519)
```

Den **öffentlichen** Schlüssel (`pp_api_key.pub`, einzeilig) hinterlegen:

- In der Web-UI: Projekt → Einstellungen → Tab „API-Schlüssel“ → Name,
  Public Key, optional Ablaufdatum.
- Per interner API mit Session (Planner/Admin):

```bash
curl -sS -X POST "https://<domain>/api/v1/projects/<projectId>/api-keys" \
  -H 'content-type: application/json' \
  --cookie cookies.txt \
  -d '{
    "name": "CI-Pipeline",
    "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… ci@example",
    "expiresAt": "2027-01-01T00:00:00Z"
  }'
```

Rückgabe (gekürzt): `{ "apiKey": { "id": 7, "keyType": "ssh-ed25519",
"fingerprint": "SHA256:…", "expiresAt": …, "isActive": true, … } }`.
Die `id` ist die spätere `x-pp-key-id`. Der private Schlüssel wird nie
übertragen oder gespeichert.

Verwaltung (Session, Planner/Admin):

| Methode & Pfad | Wirkung |
|---|---|
| `GET /api/v1/projects/{projectId}/api-keys` | Alle Schlüssel des Projekts |
| `POST /api/v1/projects/{projectId}/api-keys` | Schlüssel anlegen (`name`, `publicKey`, optional `expiresAt`) |
| `PATCH /api/v1/api-keys/{id}` | `name`, `expiresAt` (`null` = unbegrenzt), `isActive` ändern |
| `DELETE /api/v1/api-keys/{id}` | Schlüssel löschen |

## 2. Signatur-Schema

Jeder Request trägt drei Header:

| Header | Inhalt |
|---|---|
| `x-pp-key-id` | ID des hinterlegten Schlüssels (dezimal) |
| `x-pp-timestamp` | Aktuelle Unix-Zeit in **Sekunden** (dezimal) |
| `x-pp-signature` | Base64 der Signatur über den kanonischen String |

Der **kanonische String** wird mit `\n` (LF) verbunden:

```
<keyId>\n<timestamp>\n<METHOD>\n<originalUrl>\n<sha256hex(rawBody)>
```

- `keyId`/`timestamp`: exakt der Wert aus dem jeweiligen Header (getrimmt).
- `METHOD`: HTTP-Methode in Großbuchstaben (`POST`).
- `originalUrl`: vollständiger Pfad inkl. `/api/v1/external/...` und
  Query-String, z. B. `/api/v1/external/projects/1/tasks`.
- `sha256hex(rawBody)`: SHA-256 des **rohen** Request-Bodys als Hex
  (Kleinbuchstaben). Bei leerem Body: `sha256("")` =
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Signiert wird der UTF-8-Byte-Inhalt dieses Strings:

- `ssh-ed25519` → Ed25519 über die Nachricht direkt.
- `ssh-rsa` → RSA **PKCS#1 v1.5 mit SHA-256**.

In Node:

```js
const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey); // Ed25519
const signature = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), privateKey); // RSA
```

Der Server akzeptiert den Timestamp nur innerhalb von **±300 Sekunden** zur
Serverzeit (`401` sonst, Replay-Schutz).

## 3. Endpunkte

Alle Endpunkte verlangen die drei Header aus Abschnitt 2. Der Schlüssel ist an
**ein** Projekt gebunden; Anfragen an ein anderes Projekt beantwortet der
Server mit `403`.

| Methode & Pfad | Body | Antwort |
|---|---|---|
| `POST /projects/{projectId}/tasks` | wie interner `taskCreateSchema`: `name` (Pflicht), optional `parentId`, `description`, `estimatedMinutes`, `status`, `priority`, `constraintType` + `constraintDate`, `isMilestone`, `sortOrder` | `201 { task: { … } }` |
| `POST /projects/{projectId}/dependencies` | `predecessorId`, `successorId` (Pflicht; beide im Projekt), optional `type` (`FS`/`SS`/`FF`/`SF`, Standard `FS`), `lagMinutes` (auch negativ) | `201 { dependency: { … } }` |
| `POST /projects/{projectId}/tasks/{taskId}/assignments` | `resourceId` (Pflicht, Ressource im Projekt), optional `allocationPercent` (1–400, Standard 100) | `201 { assignment: { … } }` |

Es gelten dieselben Fachregeln wie in der UI: Projektzugehörigkeit,
Constraint-Prüfung (Datum nötig bei `start_no_earlier_than`/`start_on`),
verbotene Zyklen und Hierarchie-Zyklen, `sortOrder` = Maximum + 1,
Duplikat-Erkennung bei Abhängigkeiten/Zuteilungen. Nach jeder Mutation wird die
Planung neu berechnet und per WebSocket an geöffnete Clients gebroadcastet.
Audit-Einträge entstehen mit `userId = null` und Entity-Typ `task:external`,
`dependency:external` bzw. `assignment:external`.

## 4. Beispiel (Node-Script)

Voraussetzung: Node ≥ 22. `ssh-keygen` erzeugt OpenSSH-Private-Keys, die Node
nicht direkt lesen kann – daher einmalig eine PKCS#8-Kopie erzeugen (das
Original bleibt unverändert):

```bash
cp pp_api_key pp_api_key.pem
ssh-keygen -p -N "" -m PKCS8 -f pp_api_key.pem   # konvertiert in PKCS#8-PEM
```

```js
// pp-api-client.mjs
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE_URL = process.env.PP_BASE_URL ?? 'https://<domain>';
const PROJECT_ID = process.env.PP_PROJECT_ID ?? '1';
const KEY_ID = process.env.PP_KEY_ID ?? '1';
const KEY_TYPE = process.env.PP_KEY_TYPE ?? 'ssh-ed25519'; // oder "ssh-rsa"
const privateKey = createPrivateKey(readFileSync(process.env.PP_PRIVATE_KEY ?? './pp_api_key.pem'));

async function externalRequest(method, path, body) {
  const bodyString = body === undefined ? '' : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = [
    String(KEY_ID),
    String(timestamp),
    method.toUpperCase(),
    path,
    createHash('sha256').update(bodyString).digest('hex'),
  ].join('\n');

  const signature =
    KEY_TYPE === 'ssh-rsa'
      ? sign('sha256', Buffer.from(canonical, 'utf8'), privateKey)
      : sign(null, Buffer.from(canonical, 'utf8'), privateKey);

  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-pp-key-id': String(KEY_ID),
      'x-pp-timestamp': String(timestamp),
      'x-pp-signature': signature.toString('base64'),
    },
    body: bodyString || undefined,
  });
}

const tasksPath = `/api/v1/external/projects/${PROJECT_ID}/tasks`;
const response = await externalRequest('POST', tasksPath, {
  name: 'Extern angelegte Aufgabe',
  estimatedMinutes: 120,
});
console.log(response.status, await response.json());
```

## 5. Fehlercodes

Fehler kommen als RFC 7807 (`application/problem+json`) mit `type`, `title`,
`status` und optional `detail`/`errors`.

| Status | Bedeutung |
|---|---|
| `400` | Fachlich ungültig (z. B. Zyklus, Oberaufgabe→Kind, Elternaufgabe in anderem Projekt, Constraint ohne Datum) |
| `401` | Fehlende Header, ungültige/abgelaufene/deaktivierte Key-ID, falsche Signatur, Timestamp außerhalb ±300 s |
| `403` | Schlüssel gehört zu einem anderen Projekt |
| `404` | Aufgabe/Ressource nicht gefunden bzw. nicht im Projekt des Schlüssels |
| `409` | Duplikat (Abhängigkeit oder Zuteilung existiert bereits) |
| `422` | Zod-Validierung des Bodys (Details in `errors[]`) |
| `429` | Rate-Limit pro Schlüssel überschritten (120 Anfragen/Minute) |

## 6. Sicherheit & Betrieb

- **Private Key schützen:** nur der öffentliche Schlüssel liegt auf dem Server.
  Private Keys wie Passwörter behandeln, nicht ins Repository committen.
- **Replay-Schutz (serverseitig):** Zusätzlich zum ±300-s-Fenster merkt sich der
  Server jede bereits verwendete Signatur (Key + Timestamp + Signatur) für die
  Dauer des Fensters. Eine exakt wiederholte Signatur wird mit `401`
  („Signatur wurde bereits verwendet (Replay)“) abgelehnt. **Clients müssen
  daher jeden Request neu signieren** (frischer Timestamp), auch bei Retries –
  ein Netz-Retry mit unveränderten Headern schlägt fehl.
- **Pre-Auth-Rate-Limit:** 60 Anfragen/Minute pro IP (Development: 600),
  greift bereits **vor** der Signaturprüfung – auch ungültige Signaturen sind
  damit begrenzt.
- **Ablauf:** `expiresAt` setzen und Schlüssel regelmäßig rotieren: neuen
  Schlüssel anlegen, Client umstellen, alten Schlüssel deaktivieren
  (`isActive: false`) und danach löschen. Deaktivierung wirkt sofort.
- **Monitoring:** `lastUsedAt` je Schlüssel zeigt, ob er noch genutzt wird;
  ungenutzte oder abgelaufene Schlüssel löschen.
- **Schlüsseltypen:** `ssh-ed25519` (empfohlen) und `ssh-rsa` (RSA-SHA256).
  ECDSA/DSA werden nicht unterstützt.
- **Rate-Limit:** 120 Anfragen pro Minute und Schlüssel; Überschreitung → `429`.
- **Projektbindung:** Ein Schlüssel kann ausschließlich im Projekt arbeiten, in
  dem er angelegt wurde; Projektlöschung entfernt seine Schlüssel kaskadierend.
- **Audit:** Alle externen Mutationen werden mit `userId = null` und
  `*:external`-Entity-Typ protokolliert und sind so von UI-Aktionen
  unterscheidbar.
