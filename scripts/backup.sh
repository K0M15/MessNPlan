#!/usr/bin/env bash
# Erstellt einen komprimierten MySQL-Dump aus dem laufenden Compose-Stack.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p backups
ts="$(date -u +%Y%m%d-%H%M%S)"
target="backups/db-${ts}.sql.gz"

docker compose exec -T db sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
  | gzip > "$target"

echo "Backup geschrieben: $target"
