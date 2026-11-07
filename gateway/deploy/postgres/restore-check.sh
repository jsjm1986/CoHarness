#!/bin/bash
# Restore one custom-format dump into a disposable database and verify schema.
set -euo pipefail
if [ "$#" -ne 1 ]; then echo "usage: $0 /absolute/path/harness-*.dump" >&2; exit 2; fi
DUMP="$1"
# `-f` runs in the caller's CWD but the restore input opens after `cd`, so a
# relative path could validate one file and read another; require absolute.
case "$DUMP" in /*) ;; *) echo "dump path must be absolute: $DUMP" >&2; exit 2 ;; esac
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 2; }
cd "$(dirname "$0")"
DB="harness_restore_check_$(date +%s)_$$"
cleanup() {
  docker compose exec -T postgres dropdb --username harness_owner --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker compose exec -T postgres createdb --username harness_owner "$DB"
# pg_restore exits nonzero on warning-level diagnostics too; --single-transaction
# makes real errors roll the database back, so the VERSION check below stays the
# hard gate and warnings surface as a notice instead of a false failure.
if ! docker compose exec -T postgres pg_restore --username harness_owner --dbname "$DB" --clean --if-exists \
  --single-transaction < "$DUMP"; then
  echo 'pg_restore reported diagnostics; verifying restored schema anyway' >&2
fi
VERSION="$(docker compose exec -T postgres psql --username harness_owner --dbname "$DB" --tuples-only --no-align \
  --command 'SELECT max(version) FROM harness.schema_migrations')"
[ -n "$VERSION" ] || { echo 'restored database has no migration version' >&2; exit 1; }
printf 'restore_check=ok migration=%s\n' "$VERSION"
