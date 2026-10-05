#!/usr/bin/env bash
# Stellt einen Dump aus backups/ in die laufende Datenbank wieder her.
# Aufruf: scripts/restore.sh backups/db-YYYYmmdd-HHMMSS.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:?Aufruf: scripts/restore.sh backups/db-YYYYmmdd-HHMMSS.sql.gz}"
[ -f "$file" ] || { echo "Datei nicht gefunden: $file" >&2; exit 1; }

gunzip -c "$file" | docker compose exec -T db sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'

echo "Restore abgeschlossen: $file"
