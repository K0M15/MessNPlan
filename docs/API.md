# ProjectPlaner – API-Referenz

Vollständige Beschreibung der REST-API der ProjectPlaner-Anwendung. Grundlage ist die
tatsächliche Implementierung in `apps/api/src/routes/` und
`packages/shared/src/schemas.ts`; übergreifende Architektur- und Betriebshinweise
stehen in [`AGENTS.md`](../AGENTS.md).

## 1. Überblick

| Eigenschaft | Wert |
|---|---|
| Basis-URL (Dev) | `http://localhost:3000/api/v1` |
| Basis-URL (Prod) | `https://$DOMAIN/api/v1` (Caddy leitet `/api/*` an die API) |
| Request-Body | JSON (`Content-Type: application/json`, max. 1 MB) |
| Response-Body | JSON (`application/json`) |
| Fehler | RFC 7807 (`application/problem+json`), siehe Abschnitt 3 |
| Versionierung | Pfadbasiert (`/api/v1`); Änderungen am Verhalten gibt es nur unter einer neuen Version |
| Authentifizierung | httpOnly-Cookies (Access + Refresh), siehe Abschnitt 2 |

Fast alle Endpunkte unter `/api/v1` erfordern eine angemeldete Sitzung; Ausnahmen sind
`/auth/login`, `/auth/refresh`, `/auth/logout` und der Outlook-OAuth-Callback. Die
Web-App spricht die API im Dev-Betrieb über den Vite-Proxy (gleicher Origin
`http://localhost:5173`), in Produktion über Caddy auf derselben Domain – daher sind
Cookies und `Origin`-Header im Normalbetrieb unproblematisch.

Für Live-Aktualisierungen existiert zusätzlich Socket.IO unter `/socket.io` (Auth über
das `pp_at`-Cookie; Events `schedule:updated`, `task:changed`, `project:changed`,
`presence:state`, `presence:selection`). Diese Events ergänzen die REST-API, ersetzen
sie aber nicht.

## 2. Authentifizierung

Es gibt lokale Konten (Argon2id-Passwort-Hashes) und eine JWT-basierte Sitzung in
httpOnly-Cookies. Tokens werden nie im Response-Body oder localStorage abgelegt.

### 2.1 Cookies

| Cookie | Inhalt | Gültigkeit | Path | Attribute |
|---|---|---|---|---|
| `pp_at` | Access-Token (JWT, HS256) | `ACCESS_TOKEN_TTL`, Default 900 s (15 min) | `/` | `HttpOnly`, `SameSite=Strict`, `Secure` bei `COOKIE_SECURE=true` |
| `pp_rt` | Refresh-Token (Opaque, 48 Zufallsbytes, base64url) | `REFRESH_TOKEN_TTL_DAYS`, Default 30 Tage | `/api/v1/auth` | `HttpOnly`, `SameSite=Strict`, `Secure` bei `COOKIE_SECURE=true` |

Das Refresh-Cookie wird nur an die Auth-Endpunkte gesendet (Pfad-Beschränkung); in der
Datenbank liegt nur der SHA-256-Hash des Tokens.

### 2.2 Ablauf

1. **Login** – `POST /auth/login` mit `{ "email", "password" }` setzt beide Cookies und
   liefert `{ "user": … }` (ohne Passwort-Hash).
2. **Arbeiten** – alle weiteren Requests authentifizieren sich über `pp_at`. Abgelaufene
   Access-Tokens ergeben `401`.
3. **Refresh** – `POST /auth/refresh` (ohne Body) benötigt nur das `pp_rt`-Cookie und
   setzt beide Cookies neu. Der Refresh-Token wird dabei **rotiert** (einmalig
   verwendbar). Wird ein bereits rotierter Token erneut vorgelegt (Reuse), widerruft die
   API die gesamte Token-Familie des Nutzers; alle Sitzungen müssen neu aufgebaut werden.
   Parallele Refresh-Requests: genau einer gewinnt, der zweite wird wie Reuse behandelt.
   Die Web-App puffert das über einen Single-Flight-Refresh (ein Refresh, danach genau
   ein Replay des auslösenden Requests).
4. **Logout** – `POST /auth/logout` widerruft das Refresh-Token (falls vorhanden) und
   löscht beide Cookies; antwortet immer `204`.
5. **Prüfen** – `GET /auth/me` liefert den aktuellen Benutzer.

Refresh-Tokens werden außerdem bei Deaktivierung oder Passwortänderung eines Benutzers
serverseitig widerrufen (siehe `PATCH /users/:id`).

### 2.3 CSRF- und Origin-Verhalten

- Auth-Cookies sind `SameSite=Strict`, damit werden sie bei Cross-Site-Requests nicht
  mitgesendet.
- Zusätzlich prüft eine globale Prüfung alle zustandsändernden Requests (`POST`, `PUT`,
  `PATCH`, `DELETE`): Ist ein `Origin`-Header vorhanden, muss er in der Allowlist stehen
  (`APP_ORIGIN` plus optionale `ALLOWED_ORIGINS`, in Development zusätzlich
  `http://localhost:5173`, `http://localhost:3000`, `http://127.0.0.1:5173`). Fehlt der
  Header (z. B. Server-zu-Server, `curl`), wird der Request zugelassen. Browser senden
  `Origin` bei schreibenden Requests automatisch.
- CORS ist auf dieselbe Allowlist beschränkt und erlaubt Credentials
  (`Access-Control-Allow-Credentials`), damit Cookies cross-origin nur von erlaubten
  Origins mitgesendet werden dürfen.

### 2.4 Rate-Limit

Nur der Login ist limitiert: **20 Versuche / 15 Minuten pro IP** in Produktion,
**100 / 15 Minuten** in Development (E2E-Läufe). Bei Überschreitung antwortet die API mit
`429` (`urn:projectplaner:rate-limit`) und dem Standard-Header `RateLimit` (Draft-7).
Es gibt kein separates Forgot-Password/Reset-Verfahren
über die API; Passwörter ändert ein Admin über `PATCH /users/:id`.

## 3. Fehlerformat (RFC 7807)

Alle Fehler kommen als `application/problem+json` mit den Feldern `type`, `title`,
`status`, ggf. `detail`, `instance` (angefragter Pfad, sofern verfügbar) und bei
Validierungsfehlern zusätzlich `errors[]` mit `path` und `message`.

| Status | `type` | Auslöser / Beispiel-Detail |
|---|---|---|
| 400 | `urn:projectplaner:bad-request` bzw. `about:blank` | Ungültiger JSON-Body (`about:blank`, Detail „Ungültiger JSON-Body“), Arbeitsbeginn ≥ Arbeitsende, Abhängigkeit außerhalb des Projekts |
| 401 | `urn:projectplaner:unauthorized` | „Anmeldung erforderlich“, „Token ungültig oder abgelaufen“, Refresh-Token abgelaufen |
| 403 | `urn:projectplaner:forbidden` | „Rolle "planner" in diesem Projekt erforderlich“, Origin nicht erlaubt, Konto deaktiviert |
| 404 | `urn:projectplaner:not-found` | Unbekannte Route oder Entität; Projekt ohne Mitgliedschaft (bewusst 404 statt 403) |
| 409 | `urn:projectplaner:conflict` | `If-Match`-Konflikt, doppelte E-Mail/Tag/Zuteilung/Abhängigkeit, Feiertag doppelt |
| 413 | `about:blank` | Body größer als 1 MB (Express-Body-Limit) |
| 422 | `urn:projectplaner:validation` | Zod-Validierung (`errors[]`), ungültige Pfad-ID |
| 429 | `urn:projectplaner:rate-limit` | Login-Limit überschritten |
| 500 | `urn:projectplaner:internal` | Unerwarteter Fehler (Details nur im Server-Log) |

Beispiel `422` (Format der `errors[]`-Einträge):

```json
{
  "type": "urn:projectplaner:validation",
  "title": "Unprocessable Entity",
  "status": 422,
  "detail": "Validierung fehlgeschlagen",
  "instance": "/api/v1/projects",
  "errors": [
    { "path": "name", "message": "Too small: expected string to have >=1 characters" }
  ]
}
```

Beispiel `409` (Optimistic-Locking-Konflikt):

```json
{
  "type": "urn:projectplaner:conflict",
  "title": "Conflict",
  "status": 409,
  "detail": "Aufgabe wurde zwischenzeitlich geändert. Bitte neu laden.",
  "instance": "/api/v1/tasks/42"
}
```

Unbekannte Pfade unter `/api/*` liefern das 404-Format; alle anderen Pfade sind SPA-
Routen und werden in Produktion von Caddy ausgeliefert.

## 4. Konventionen

### 4.1 IDs, Zeiten und Dauern

- **IDs** sind positive Ganzzahlen (JSON-Zahlen, DB-seitig `BIGINT UNSIGNED`).
- **Zeitstempel** sind ISO-8601-Strings in UTC mit Millisekunden
  (`"2026-10-05T08:30:00.000Z"`). Die DB speichert UTC; die Anzeige/Planung erfolgt in
  `projects.timezone`.
- **Datumsfelder ohne Uhrzeit** (Feiertage, `scheduleAnchor`) sind `"YYYY-MM-DD"`.
- **Dauern** sind immer Minuten (`estimatedMinutes`, `lagMinutes`, `slackMinutes`,
  `capacityMinutesPerDay`, `allocationPercent` als Prozent).
- **Arbeitszeiten** im Projekt sind `"HH:MM"` oder `"HH:MM:SS"` in der Projekt-Zeitzone;
  `workweek` ist ein JSON-Array mit `0 = Sonntag` bis `6 = Samstag`.

### 4.2 Optimistic Locking (`If-Match`)

Entitäten mit `version`-Spalte: Projekte, Aufgaben, Ressourcen und Zuteilungen.
Schreibende Requests (`PATCH`) können die zuletzt gelesene Version als
`If-Match: <version>` mitschicken (Anführungszeichen sind erlaubt). Passt die Version
nicht, antwortet die API mit `409` und es wird nichts geändert. Ohne `If-Match` wird
bedingungslos geschrieben (Last-Write-Wins). `POST /tasks/:id/move` unterstützt
`If-Match` ebenfalls. Abhängigkeiten, Tags und Kommentare besitzen keine Version.

### 4.3 Pagination und Suche

- `GET /users` (Admin) unterstützt `page` (ab 1, Default 1), `pageSize` (1–200,
  Default 50) und `q` (Freitext über Name/E-Mail). Antwort:
  `{ "items": [...], "page": 1, "pageSize": 50, "total": 123 }`.
- `GET /users/lookup` unterstützt `q` und liefert maximal 20 aktive Nutzer.
- Alle übrigen Listen sind projektbezogen (überschaubar) und werden ohne Pagination
  vollständig geliefert (`{ "items": [...] }`), ggf. sortiert.

### 4.4 Rollen

**Globale Rollen** (`users.role`): `admin`, `planner`, `member`, `viewer`.

**Projektrollen** (`project_members.role`): `planner` > `member` > `viewer`.

- Globale Admins haben immer vollen Zugriff auf alle Projekte.
- Wer kein Mitglied ist, erhält für das Projekt `404` (Existenz wird verborgen).
  Mitglieder mit zu niedriger Projektrolle erhalten `403`.
- `viewer` darf lesen, `member` darf Inhalte bearbeiten (Aufgaben, Abhängigkeiten,
  Zuteilungen, Tags am Task, Kommentare), `planner` darf Struktur/Stammdaten ändern
  (Aufgaben löschen, Projekt/Mitglieder/Feiertage/Ressourcen/Tags verwalten,
  Outlook-Sync anstoßen).
- Globale Rolle `planner` benötigt man zusätzlich zum **Anlegen** neuer Projekte
  (`POST /projects`); der Ersteller wird automatisch Projekt-`planner`.

In den Tabellen unten steht die **mindestens nötige Rolle**; `Admin` ist jeweils
eingeschlossen.

### 4.5 Fachliche Enums

| Feld | Werte |
|---|---|
| Aufgaben-Status | `todo`, `in_progress`, `blocked`, `done` |
| Priorität | `low`, `normal`, `high`, `urgent` |
| Constraint-Typ | `asap`, `start_no_earlier_than`, `start_on` |
| Abhängigkeitstyp | `FS` (Ende→Start, Standard), `SS`, `FF`, `SF` – je mit `lagMinutes` (auch negativ) |
| Projektstatus | `active`, `archived` |
| Ressourcentyp | `person`, `machine` |
| Outlook-Verbindungsstatus | `connected`, `error`, `revoked` |

Zyklen in Abhängigkeiten und in der Aufgabenhierarchie werden beim Anlegen abgelehnt
(`400`). Elternaufgaben ohne Schätzung erben den Zeitraum ihrer Kinder (Rollup);
Meilensteine haben Dauer 0.

### 4.6 Realtime (Socket.IO)

Der Socket verbindet sich mit dem `pp_at`-Cookie (`withCredentials`). Client-Nachrichten:
`project:join(projectId)`, `project:leave(projectId)`,
`presence:selection({ projectId, taskId | null })`. Der Server sendet `schedule:updated`,
`task:changed`, `project:changed`, `presence:state` und `presence:selection` nur an den
jeweiligen Projekt-Room. Nach einem Token-Refresh verbindet sich der Client neu.

## 5. REST-Endpunkt-Referenz

Rollenkürzel: `öffentlich` = ohne Anmeldung, `angemeldet` = gültige Sitzung,
`viewer`/`member`/`planner` = mindestens diese Projektrolle (Admin immer erlaubt).

### 5.1 Auth

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| POST | `/auth/login` | öffentlich | `{email, password}` → `200 {user}` + Access-/Refresh-Cookie. `401` bei falschem Login, `403` bei deaktiviertem Konto, `429` bei Rate-Limit. |
| POST | `/auth/refresh` | Refresh-Cookie | Rotiert Refresh-Token, setzt beide Cookies neu → `200 {user}`. `401` bei abgelaufenem/bereits verwendetem Token (Reuse widerruft alle Sitzungen). |
| POST | `/auth/logout` | optional | Widerruft das Refresh-Token und löscht die Cookies → `204`, auch wenn keine Sitzung existiert. |
| GET | `/auth/me` | angemeldet | `200 {user}` des aktuellen Kontos; `401` ohne gültiges Access-Token oder bei deaktiviertem Konto. |

Das Benutzerobjekt enthält: `id`, `email`, `name`, `role`, `isActive`, `createdAt`,
`updatedAt` – niemals den Passwort-Hash.

### 5.2 Users

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/users/lookup` | angemeldet | `?q=` Suche über Name/E-Mail; nur aktive Nutzer, max. 20 → `{items:[{id,name,email}]}` (für Mitglieder-Auswahl). |
| GET | `/users` | Admin | `page`, `pageSize`, `q` → `{items, page, pageSize, total}`. |
| POST | `/users` | Admin | `{email, name, password (10–200 Zeichen), role?}` → `201 {user}`; `409` bei vergebener E-Mail. |
| GET | `/users/:id` | Admin | `200 {user}`; `404` unbekannt. |
| PATCH | `/users/:id` | Admin | Partielles Update `{email?, name?, password?, role?, isActive?}` → `200 {user}`. Eigenes Konto kann nicht deaktiviert/herabgestuft werden, der letzte aktive Admin ebenfalls nicht (`400`). Deaktivierung/Passwortwechsel widerruft Refresh-Tokens. |
| DELETE | `/users/:id` | Admin | Soft-Delete (`isActive=false`), widerruft alle Refresh-Tokens → `204`. Eigenes Konto und letzter aktiver Admin sind geschützt. |

### 5.3 Projects

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/projects` | angemeldet | Admin sieht alle Projekte, sonst nur eigene Mitgliedschaften; je Eintrag zusätzlich `myRole`. |
| POST | `/projects` | Admin/Planner | `projectCreateSchema` → `201 {project}` (Ersteller wird Projekt-`planner`). `400` wenn `workdayStart >= workdayEnd`. |
| GET | `/projects/:id` | viewer | `200 {project: {…, myRole}, members:[{userId, role, name, email}]}`. |
| PATCH | `/projects/:id` | planner | Partielles Update, unterstützt `If-Match` → `200 {project}`. Kalender-/Ankeränderungen stoßen eine Neuberechnung an. |
| DELETE | `/projects/:id` | planner | Löscht das Projekt kaskadierend (Aufgaben, Ressourcen, …) → `204`. |
| GET | `/projects/:id/members` | viewer | `{items:[{userId, role, name, email}]}`. |
| POST | `/projects/:id/members` | planner | `{userId, role?}` (Upsert) → `201 {member}`; `404` wenn Nutzer unbekannt/inaktiv. |
| DELETE | `/projects/:id/members/:userId` | planner | `204`. |
| GET | `/projects/:id/holidays` | viewer | `{items}` sortiert nach Datum (`id`, `projectId`, `date`, `name`). |
| POST | `/projects/:id/holidays` | planner | `{date, name}` → `201 {holiday}`; `409` wenn für den Tag schon ein Feiertag existiert; löst Neuberechnung aus. |
| DELETE | `/projects/:id/holidays/:holidayId` | planner | `204`; löst Neuberechnung aus. |

Projektfelder: `id`, `name`, `description`, `timezone`, `workweek`, `workdayStart`,
`workdayEnd`, `scheduleAnchor`, `status`, `createdBy`, `version`, `createdAt`,
`updatedAt`. Defaults beim Anlegen: `timezone: "Europe/Berlin"`, `workweek: [1,2,3,4,5]`,
`workdayStart: "08:00"`, `workdayEnd: "16:00"`, `status: "active"`.

### 5.4 Tasks

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/projects/:projectId/tasks` | viewer | Liste aller Aufgaben, sortiert nach `sortOrder`, `id`. `?tree=1` liefert den verschachtelten Baum (`children[]`), sonst flach. Jede Aufgabe enthält zusätzlich `tags[]` und `assignments[]`. |
| POST | `/projects/:projectId/tasks` | member | `{name, parentId?, description?, estimatedMinutes?, status?, priority?, constraintType?, constraintDate?, isMilestone?, sortOrder?}` → `201 {task}`. `parentId` muss im Projekt liegen; bei `start_no_earlier_than`/`start_on` ist `constraintDate` Pflicht (`400`). Neuberechnung + Realtime-Event. |
| GET | `/tasks/:id` | viewer | `200 {task: {…, tags, assignments}, project: {id, name, myRole}}` (`myRole` ist in dieser Route derzeit `null`). |
| PATCH | `/tasks/:id` | member | Partielles Update `{name?, description?, estimatedMinutes?, status?, priority?, constraintType?, constraintDate?, isMilestone?, progress?, actualStart?, actualEnd?}`, unterstützt `If-Match` → `200 {task}`. `asap` setzt `constraintDate` auf `null`. |
| DELETE | `/tasks/:id` | planner | Löscht Aufgabe und Teilaufgaben kaskadierend → `204`; Neuberechnung + Realtime. |
| POST | `/tasks/:id/move` | member | `{parentId?, sortOrder?}` (+ optional `If-Match`) → `200 {task}`. Verhindert Selbst-/Nachfahren-Verschiebung und vergibt `sortOrder` automatisch ans Ende. Neuberechnung. |

Aufgabenfelder: `id`, `projectId`, `parentId`, `name`, `description`,
`estimatedMinutes` (0 … 527040, d. h. 366 Tage), `progress` (0–100), `status`,
`priority`, `constraintType`, `constraintDate`, `isMilestone`, `sortOrder`,
`plannedStart`, `plannedEnd`, `actualStart`, `actualEnd`, `scheduleVersion`,
`createdBy`, `version`, `createdAt`, `updatedAt` sowie bei Liste/Detail
`tags[]` und `assignments[]`.

Hinweis: `plannedStart`/`plannedEnd` werden ausschließlich vom Scheduler gesetzt
(berechnete Planzeiten), nicht per `PATCH`.

### 5.5 Dependencies

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/tasks/:id/dependencies` | viewer | `{predecessors:[], successors:[]}` – Vorgänger sind Kanten, in denen die Aufgabe Nachfolger ist, umgekehrt für Nachfolger. Einträge enthalten `id`, `predecessorId`, `successorId`, `type`, `lagMinutes` und beide Aufgabennamen. |
| POST | `/tasks/:id/dependencies` | member | `{predecessorId, successorId, type?, lagMinutes?}` → `201 {dependency}`. `:id` muss Vorgänger oder Nachfolger sein; beide Aufgaben müssen im selben Projekt liegen; Zyklen und Hierarchie-Zyklen werden abgelehnt (`400`), Duplikate ergeben `409`. |
| PATCH | `/dependencies/:id` | member | `{type?, lagMinutes?}` → `200 {dependency}`. |
| DELETE | `/dependencies/:id` | member | `204`. |

Standard: `type: "FS"`, `lagMinutes: 0`; Lag ist auf ±527040 Minuten begrenzt.
Jede Änderung stößt eine Neuberechnung an.

### 5.6 Resources

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/projects/:projectId/resources` | viewer | `{items}` inkl. `openAssignmentCount` (Zuteilungen nicht erledigter Aufgaben). |
| POST | `/projects/:projectId/resources` | planner | `{name, type?, userId?, email?, capacityMinutesPerDay?, workingHours?, color?, isActive?}` → `201 {resource}`. |
| PATCH | `/resources/:id` | planner | Partielles Update, unterstützt `If-Match` → `200 {resource}`. |
| DELETE | `/resources/:id` | planner | `204` (kaskadiert auf Zuteilungen). |
| GET | `/resources/:id/assignments` | viewer | `{items}` aller Zuteilungen der Ressource (`id`, `taskId`, `allocationPercent`, `plannedStart`, `plannedEnd`). |

Ressourcenfelder: `id`, `projectId`, `userId`, `name`, `type`, `email`,
`capacityMinutesPerDay` (0–1440, Default 480), `workingHours` (freies JSON, wird für die
Planung derzeit nicht ausgewertet), `color` (`#RRGGBB`), `isActive`, `version`,
`createdAt`, `updatedAt`. Optional verknüpfte Nutzer (`userId`) dienen der
Outlook-Zuordnung.

### 5.7 Assignments

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/tasks/:id/assignments` | viewer | `{items}` – `id`, `resourceId`, `resourceName`, `resourceType`, `allocationPercent`, `plannedStart`, `plannedEnd`, `version`. |
| POST | `/tasks/:id/assignments` | member | `{resourceId, allocationPercent?}` (1–400, Default 100) → `201 {assignment}`. Ressource muss im selben Projekt liegen (`404`), Duplikat `409`. |
| PATCH | `/assignments/:id` | member | `{allocationPercent}` (1–400) + `If-Match` → `200 {assignment}`. |
| DELETE | `/assignments/:id` | member | `204`. |

Zuteilungen bestimmen die Ressourcen-Auslastung; die Verteilung auf Arbeitstage ist eine
gleichmäßige Näherung (siehe `docs/operations` bzw. `services/utilization.ts`).

### 5.8 Tags

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/projects/:projectId/tags` | viewer | `{items}` inkl. `usageCount`. |
| POST | `/projects/:projectId/tags` | planner | `{name, color?}` (Default `#64748b`) → `201 {tag}`; `409` bei doppeltem Namen im Projekt. |
| PATCH | `/tags/:id` | planner | `{name?, color?}` → `200 {tag}`. |
| DELETE | `/tags/:id` | planner | `204` (entfernt auch Task-Zuordnungen). |
| PUT | `/tasks/:id/tags` | member | `{tagIds: [...]}` **ersetzt** die komplette Zuordnung (max. 50 IDs); unbekannte IDs oder Tags aus einem anderen Projekt ergeben `400` → `200 {tags}`. |

### 5.9 Comments

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/tasks/:id/comments` | viewer | `{items}` aufsteigend nach `createdAt` – `id`, `taskId`, `userId`, `userName`, `body`, `createdAt`, `updatedAt`. |
| POST | `/tasks/:id/comments` | member | `{body}` (1–20000 Zeichen) → `201 {comment}` + Realtime. |
| PATCH | `/comments/:id` | Autor oder planner/Admin | `{body}` → `200 {comment}`; `403` für andere Mitglieder. |
| DELETE | `/comments/:id` | Autor oder planner/Admin | `204`. |

### 5.10 Schedule, Gantt und Health

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| POST | `/projects/:projectId/schedule` | member | Führt die CPM-Berechnung synchron aus und persistiert die Planzeiten. Body optional (`{ "leveling": false }` wird validiert, hat derzeit aber keine Wirkung) → `200 {result}` mit `projectId`, `version`, `taskCount`, `cyclicCount`, `computedAt`. Broadcast `schedule:updated`. |
| GET | `/projects/:projectId/schedule` | viewer | Liefert das vollständige Plan-Payload (siehe unten) inkl. `critical`/`slackMinutes`. |
| GET | `/projects/:projectId/gantt` | viewer | Wie `/schedule`, zusätzlich `utilization`. Query: `from`, `to` (ISO-Zeitstempel) und `bucketMinutes` (1 … 44640). Defaults: Zeitraum aus frühestem Start bis spätestem Ende ± 2 Tage, Bucket-Größe nach Spanne (60 min bei ≤ 2 Tagen, 240/1440/10080/43200 bei größeren Spannen). `422`, wenn Buckets × Ressourcen 50 000 überschreiten. |
| GET | `/projects/:projectId/health` | viewer | „Fertig geplant“-Prüfung → `{issues:[…], summary:{error,warning,info,total}}`. |

**Schedule-Payload** (identisch für `/schedule` und Basis von `/gantt`):

```json
{
  "project": { "id": 1, "name": "…", "timezone": "Europe/Berlin", "workweek": [1,2,3,4,5],
               "workdayStart": "08:00:00", "workdayEnd": "16:00:00",
               "scheduleAnchor": null, "version": 3 },
  "version": 7,
  "tasks": [
    { "id": 10, "parentId": null, "name": "…", "estimatedMinutes": 480, "isMilestone": false,
      "status": "todo", "progress": 0, "constraintType": "asap", "constraintDate": null,
      "plannedStart": "2026-10-05T06:00:00.000Z", "plannedEnd": "2026-10-05T14:00:00.000Z",
      "scheduleVersion": 7, "critical": true, "slackMinutes": 0 }
  ],
  "edges":  [ { "id": 1, "predecessorId": 10, "successorId": 11, "type": "FS", "lagMinutes": 0 } ],
  "resources": [ { "id": 1, "name": "…", "type": "person", "color": null,
                   "capacityMinutesPerDay": 480, "email": null } ],
  "assignments": [ { "id": 1, "taskId": 10, "resourceId": 1, "allocationPercent": 100,
                     "plannedStart": "…", "plannedEnd": "…" } ]
}
```

**Auslastung** (`utilization` im Gantt-Payload): `{from, to, bucketMinutes, buckets[]}`,
je Bucket `{resourceId, start, allocatedMinutes, capacityMinutes}` – Verteilung der
Aufwände gleichmäßig auf Arbeitstage/-stunden (Näherung).

**Health-Issues**: `{rule, severity, message, taskId?, resourceId?, details?}`. Regeln aus
`planningHealth.ts`:

| Regel | Severity | Bedeutung |
|---|---|---|
| `missing_estimate` | error | Blattaufgabe ohne Zeitschätzung (kein Meilenstein) |
| `dependency_cycle` | error | Aufgabe in einem Abhängigkeitszyklus |
| `resource_overallocated` | error | Ressource über `capacityMinutesPerDay` hinaus belegt |
| `no_resource` | warning | Aufgabe mit Dauer ohne Ressourcenzuteilung |
| `orphan_task` | warning | Blattaufgabe ohne Vorgänger und ohne Start-Constraint |
| `overdue` | warning | Geplantes Ende liegt in der Vergangenheit |
| `milestone_without_date` | warning | Meilenstein ohne berechneten Termin |
| `parent_child_mismatch` | info | Elternaufgabe „done“, Kind noch offen |
| `resource_without_email` | info | Ressource ohne E-Mail – Outlook-Sync nicht möglich |

### 5.11 Outlook-Integration (Microsoft Graph)

Die Outlook-Anbindung ist delegiert (OAuth 2.0 Authorization Code + PKCE); Tokens werden
verschlüsselt (`APP_ENCRYPTION_KEY`) gespeichert. Der Sync läuft asynchron über die
Outbox (`outlook.sync`) und legt/aktualisiert Kalendertermine zu Zuteilungen an.

| Methode | Pfad | Rolle | Zweck / Request → Response |
|---|---|---|---|
| GET | `/integrations/outlook/connect` | angemeldet | Query `resourceId?` (Postfach einer Ressource/Maschine) und `projectId?` (Rücksprungziel). Antwort `{authorizeUrl}`; zusätzlich wird ein `pp_oauth_state`-Cookie gesetzt. `400`, wenn Graph oder `APP_ENCRYPTION_KEY` fehlen; für `resourceId` ist Admin, Eigentümer oder Projekt-`planner` nötig. |
| GET | `/integrations/outlook/callback` | öffentlich | Vom Browser nach Microsoft-Redirect aufgerufen. Ohne Session-Cookie; Authentizität über signierten State (10 min) + Nonce-Cookie (Lax). Leitet auf `APP_ORIGIN` um: `?outlook=connected` oder `?outlook=error&reason=…`. |
| GET | `/projects/:projectId/outlook/connections` | viewer | `{configured, items:[{id, resourceId, resourceName, mailbox, status, syncEnabled, lastSyncAt, lastError}]}`. |
| PATCH | `/integrations/outlook/connections/:id` | planner (oder Eigentümer/Admin) | `{syncEnabled}` → `200 {connection}`; aktiviert den Sync ggf. sofort per Job. |
| DELETE | `/integrations/outlook/connections/:id` | planner (oder Eigentümer/Admin) | Löscht Verbindung samt zugehöriger Termine → `204`. |
| POST | `/projects/:projectId/outlook/sync` | planner | Reiht einen manuellen Sync-Job ein → `202 {queued:true}`. |

Connection-DTO (sicher, ohne Tokens): `id`, `userId`, `resourceId`, `mailbox`, `status`,
`syncEnabled`, `lastSyncAt`, `lastError`, `createdAt`, `updatedAt`. Fehler beim Sync
erscheinen als `lastError` an der Verbindung.

## 6. cURL-Beispiele

Voraussetzungen: Dev-API unter `http://localhost:3000`, Seed-Admin aus `.env`
(Default `admin@example.com` / `admin1234!`), `jq` optional. Zustandsändernde Requests
erhalten einen `Origin`-Header aus der Allowlist (wie im Browser) – ohne Header
funktionieren sie ebenfalls.

**1. Login mit Cookie-Jar:**

```bash
curl -i -c cookies.txt \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:5173' \
  -d '{"email":"admin@example.com","password":"admin1234!"}' \
  http://localhost:3000/api/v1/auth/login
```

**2. Projekt anlegen** (Antwort enthält die Projekt-ID):

```bash
curl -s -b cookies.txt \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:5173' \
  -d '{"name":"Website-Relaunch","timezone":"Europe/Berlin"}' \
  http://localhost:3000/api/v1/projects
```

**3. Aufgabe und Abhängigkeit anlegen** (`PROJECT_ID` aus Schritt 2):

```bash
PROJECT_ID=1

TASK_1=$(curl -s -b cookies.txt \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"name":"Konzept","estimatedMinutes":480}' \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/tasks | jq -r '.task.id')

TASK_2=$(curl -s -b cookies.txt \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"name":"Umsetzung","estimatedMinutes":960}' \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/tasks | jq -r '.task.id')

curl -s -b cookies.txt \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d "{\"predecessorId\":$TASK_1,\"successorId\":$TASK_2,\"type\":\"FS\",\"lagMinutes\":0}" \
  http://localhost:3000/api/v1/tasks/$TASK_1/dependencies
```

**4. Plan berechnen** (danach stehen `plannedStart`/`plannedEnd` fest):

```bash
curl -s -b cookies.txt -X POST \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{}' \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/schedule
```

**5. Gantt abrufen** (Schedule-Payload + Auslastungs-Buckets):

```bash
curl -s -b cookies.txt \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/gantt?from=2026-10-05T00:00:00Z&to=2026-11-05T00:00:00Z&bucketMinutes=1440"
```

**Optional: Optimistic Locking** – PATCH mit `If-Match`; bei veralteter Version `409`:

```bash
curl -s -b cookies.txt -X PATCH \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -H 'If-Match: 3' \
  -d '{"name":"Neuer Name"}' \
  http://localhost:3000/api/v1/tasks/$TASK_1
```

**Optional: Refresh/Logout** – das `pp_rt`-Cookie wird dank Pfad-Beschränkung nur an
`/api/v1/auth/*` gesendet:

```bash
curl -s -b cookies.txt -c cookies.txt -X POST \
  -H 'Origin: http://localhost:5173' \
  http://localhost:3000/api/v1/auth/refresh

curl -s -b cookies.txt -c cookies.txt -X POST \
  -H 'Origin: http://localhost:5173' \
  http://localhost:3000/api/v1/auth/logout
```

## 7. Externe API (in Arbeit)

Für Maschinen-zu-Maschinen-Integrationen ist eine separate externe API geplant;
Dokumentation entsteht parallel unter `docs/API-external.md` (noch nicht eingecheckt).
Prinzip: Statt Cookies/JWT werden Requests mit einem SSH-Schlüssel signiert; die API
verifiziert die Signatur gegen den hinterlegten öffentlichen Schlüssel des Integrations-
Accounts und lehnt nicht signierte oder unbekannte Schlüssel ab. Details, Endpunkte und
Schlüsselverwaltung folgen in der genannten Datei, sobald die Implementierung steht.

## 8. Betrieb und Healthchecks

Diese Endpunkte liegen **außerhalb** von `/api/v1` und sind nicht versioniert:

| Methode | Pfad | Zugriff | Zweck / Antwort |
|---|---|---|---|
| GET | `/healthz` | öffentlich (auch von Caddy beantwortet) | Liveness ohne DB-Zugriff → `200 {status:"ok", uptime}`. |
| GET | `/readyz` | nur intern | Readiness inkl. `SELECT 1` → `200 {status:"ok", checks:{database:true}}` bzw. `503` bei DB-Ausfall. |
| GET | `/metrics` | nur intern | Prometheus-Metriken (`pp_http_requests_total`, `pp_http_request_duration_seconds`, `pp_outbox_jobs` u. a.). Caddy leitet `/metrics` nicht nach außen; Scrape über `http://api:3000/metrics` im Docker-Netz. |

Interne Schnittstelle für den Worker: `POST /internal/broadcast` mit Header
`x-internal-token: $JWT_SECRET` (Body `{projectId, event, payload}` → `204`) – nur für den
Worker-Prozess, nicht für Clients.

Weiterführend: [`docs/operations/monitoring.md`](./operations/monitoring.md) (Healthchecks,
Metriken, Alerting) und [`docs/operations/backup-restore.md`](./operations/backup-restore.md)
(Backup/Restore).
