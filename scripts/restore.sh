#!/usr/bin/env bash
#
# Restore a dump made by scripts/backup.sh into the compose database, replacing what is there.
#
#   bash scripts/restore.sh backups/openbot-20261031-0100.dump         # shows what it would restore
#   bash scripts/restore.sh backups/openbot-20261031-0100.dump --yes   # restores it
#
# Refused while the API server answers, so a restore never races live writes. Stop it first with
# scripts/stop.sh, then `docker compose up -d postgres`, restore, and start again.

. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."

file="${1:-}"
confirmed="${2:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Usage: bash scripts/restore.sh <dump file> [--yes]" >&2
  exit 1
fi

SERVER_PORT="${SERVER_PORT:-$(grep -E '^SERVER_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' \r" || true)}"
SERVER_PORT="${SERVER_PORT:-3001}"
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$SERVER_PORT/health" 2>/dev/null; then
  echo "The API server is still answering on port $SERVER_PORT. Stop it first (bash scripts/stop.sh)." >&2
  exit 1
fi

# The compose server and routine worker write to the database too, when they are what is running.
if [ -n "$(docker compose ps --status running --quiet server worker 2>/dev/null)" ]; then
  echo "The compose server or worker is running. Stop them first (docker compose stop server worker)." >&2
  exit 1
fi

tables="$(docker compose exec -T postgres pg_restore --list <"$file" | grep -c ' TABLE DATA ' || true)"
echo "$file holds data for $tables tables."
if [ "$confirmed" != "--yes" ]; then
  echo "Nothing was changed. Run again with --yes to replace the current database with it."
  exit 0
fi

# --clean drops only what the dump holds, so restore onto the version of myduet that made the dump,
# or onto an empty database (docker compose down -v postgres, then up).
docker compose exec -T postgres pg_restore -U openbot -d openbot --clean --if-exists --no-owner --single-transaction <"$file"
echo "Restored $file."
