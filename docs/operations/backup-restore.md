# Backup & Restore (Runbook)

Der Prod-Stack enthält einen `backup`-Service (mysql:8.4), der täglich ein
komprimiertes `mysqldump` nach `./backups/<db>-YYYYmmdd-HHMMSS.sql.gz` schreibt
und Dateien älter als 14 Tage löscht.

## Manuelles Backup

```bash
scripts/backup.sh          # schreibt backups/db-<timestamp>.sql.gz
```

## Restore

```bash
scripts/restore.sh backups/db-20261005-120000.sql.gz
```

Der Restore überschreibt bestehende Tabelleninhalte. Vorher:

1. Wartungsfenster ankündigen, `api` und `worker` stoppen:
   `docker compose stop api worker web`
2. Restore ausführen (siehe oben).
3. `docker compose up -d`
4. Verifikation:
   - `curl -fsS https://$DOMAIN/healthz`
   - Login und Stichprobe in der Projektliste
   - `docker compose exec db mysql -u$MYSQL_USER -p"$MYSQL_PASSWORD" $MYSQL_DATABASE -e "select count(*) from projects; select count(*) from tasks;"`

## Restore-Drill (monatlich, Pflicht)

Ein Backup ist erst dann ein Backup, wenn der Restore getestet wurde. Der Drill
läuft **nicht** gegen die Produktivdatenbank, sondern gegen eine Wegwerf-Instanz:

```bash
# 1) Wegwerf-MySQL starten (eigener Port, kein Konflikt mit Prod)
docker run -d --rm --name pp-restore-drill \
  -e MYSQL_ROOT_PASSWORD=drill -e MYSQL_DATABASE=projectplaner \
  -p 127.0.0.1:3307:3306 mysql:8.4

# 2) Dump einspielen
gunzip -c backups/<neuester-dump>.sql.gz | \
  docker exec -i pp-restore-drill mysql -uroot -pdrill projectplaner

# 3) Stichproben zählen
docker exec pp-restore-drill mysql -uroot -pdrill projectplaner -e \
  "select (select count(*) from projects) projects, (select count(*) from tasks) tasks, (select count(*) from users) users;"

# 4) Aufräumen
docker rm -f pp-restore-drill
```

Ergebnis mit Datum in der Betriebsdoku/Issue festhalten (z. B. im Session-Log
`AGENTS.md` §10).

## Aufbewahrung & Off-Site

- Standard: 14 Tage lokal (`backup`-Service).
- Empfehlung Prod: `backups/` zusätzlich per `rclone`/`restic` in einen
  Object-Store spiegeln und dort 90 Tage aufbewahren (nicht Teil des Compose-Stacks).
- `APP_ENCRYPTION_KEY` und `JWT_SECRET` **separat** sichern: Ohne den
  Encryption-Key sind gespeicherte Outlook-Tokens nach einem Restore unlesbar
  (Verbindungen müssen neu aufgebaut werden). Ohne `JWT_SECRET` werden alle
  Sessions ungültig.
