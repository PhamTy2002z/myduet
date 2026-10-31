#!/usr/bin/env bash
#
# Back up the compose database: every conversation, memory, Bot and audit row lives there, so this
# file is the deployment. A dump is kept only once `pg_restore --list` can read it back, and dumps
# older than BACKUP_RETAIN_DAYS are removed. Nothing here prints a credential: the dump runs inside
# the postgres container as its own user.
#
#   bash scripts/backup.sh            # into ./backups (or BACKUP_DIR)
#   BACKUP_RETAIN_DAYS=30 bash scripts/backup.sh

. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-7}"
case "$RETAIN_DAYS" in
  '' | *[!0-9]*) echo "BACKUP_RETAIN_DAYS must be a whole number of days, not '$RETAIN_DAYS'." >&2; exit 1 ;;
esac

# Every conversation and stored credential is in a dump: readable by this user only.
umask 077
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/openbot-$(date +%Y%m%d-%H%M%S).dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

docker compose exec -T postgres pg_dump -U openbot -d openbot -Fc >"$partial"
# A dump that cannot be listed cannot be restored either; better to fail now than on the day it is needed.
if ! docker compose exec -T postgres pg_restore --list <"$partial" >/dev/null; then
  echo "The dump could not be read back, so it was not kept." >&2
  exit 1
fi
mv "$partial" "$file"
echo "Backed up to $file ($(du -h "$file" | cut -f1))."

find "$BACKUP_DIR" -name 'openbot-*.dump' -type f -mtime "+$RETAIN_DAYS" -print -delete |
  sed 's/^/Removed, older than the retention window: /'
