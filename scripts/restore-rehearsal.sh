#!/usr/bin/env bash
# Restore a production dump into a throwaway Postgres and prove the app could run against it.
#
# An untested backup is a hypothesis. This is the experiment: it restores, then asserts the schema
# is one this code actually matches — not merely that the file was readable.
#
# Usage: scripts/restore-rehearsal.sh <dump-file>            (or: make restore-rehearsal DUMP=...)
#
# Nothing here touches a real database. It starts its own container, on a port of its own, with no
# volume, and removes it on exit including on failure.

set -euo pipefail

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
    echo "usage: $0 <dump-file>   (.sql, .sql.gz, or pg_dump custom format)" >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Matches production (TODO #35): client and server can then never disagree about format.
PG_IMAGE="postgres:17-alpine"
CONTAINER="fd-restore-rehearsal-$$"
PGUSER="frontdashboard"
PGDB="restore_rehearsal"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Restore rehearsal: $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"
echo

docker run -d --rm --name "$CONTAINER" -p "$PORT:5432" \
    -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB="$PGDB" \
    -v "$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")":/dump:ro \
    "$PG_IMAGE" >/dev/null

# Readiness is "the target database answers a query", not "a socket accepted": the entrypoint
# runs initdb against a temporary server and then restarts, and pg_isready answers during that
# window — so a socket check races the shutdown and lands on a server about to stop.
ready() { docker exec "$CONTAINER" psql -qtAX -U "$PGUSER" -d "$PGDB" -c 'SELECT 1' >/dev/null 2>&1; }
for _ in $(seq 1 60); do
    ready && break
    sleep 1
done
if ! ready; then
    echo "postgres never came up:" >&2
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    exit 1
fi

echo "Restoring..."
case "$DUMP" in
    *.gz)  docker exec "$CONTAINER" sh -c "gunzip -c /dump | psql -q -U $PGUSER -d $PGDB" >/dev/null ;;
    *.sql) docker exec "$CONTAINER" sh -c "psql -q -U $PGUSER -d $PGDB -f /dump" >/dev/null ;;
    *)     docker exec "$CONTAINER" pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --no-privileges /dump >/dev/null ;;
esac
echo

q() { docker exec "$CONTAINER" psql -qtAX -U "$PGUSER" -d "$PGDB" -c "$1" 2>/dev/null || echo ""; }

echo "Assertions"

# 1. The dump carries a migration stamp at all.
STAMPED="$(q "SELECT count(*) FROM alembic_version;")"
if [[ "$STAMPED" == "1" ]]; then
    pass "alembic_version holds exactly one revision"
else
    fail "alembic_version holds '$STAMPED' rows — expected 1"
fi

# 2. That stamp is the revision this checkout expects.
RESTORED_REV="$(q "SELECT version_num FROM alembic_version LIMIT 1;")"
HEAD_REV="$(cd "$REPO_ROOT/backend" && uv run alembic heads 2>/dev/null | head -1 | awk '{print $1}')"
if [[ -n "$HEAD_REV" && "$RESTORED_REV" == "$HEAD_REV" ]]; then
    pass "revision matches repo head ($HEAD_REV)"
else
    fail "revision is '$RESTORED_REV', repo head is '$HEAD_REV' — migrate before trusting this restore"
fi

# 3. The real test: models against the restored schema. A correct stamp over a damaged schema
#    passes assertion 2 and fails here, which is the whole reason this runs.
if (cd "$REPO_ROOT/backend" \
    && DATABASE_URL="postgresql+asyncpg://$PGUSER:rehearsal@localhost:$PORT/$PGDB" \
       uv run alembic check >/dev/null 2>&1); then
    pass "alembic check — models match the restored schema"
else
    fail "alembic check found drift: this schema is NOT one the current code can run against"
fi

# 4. A dump of the wrong database restores cleanly and holds nothing.
USERS="$(q "SELECT count(*) FROM users;")"
if [[ "${USERS:-0}" =~ ^[0-9]+$ ]] && (( USERS > 0 )); then
    pass "users table has $USERS rows"
else
    fail "users table has '$USERS' rows — is this a dump of the right database?"
fi

echo
echo "Contents"
q "SELECT '  ' || relname || ': ' || n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY n_live_tup DESC LIMIT 12;"

echo
if (( FAILED )); then
    echo "REHEARSAL FAILED — see above. Do not treat this dump as a working backup."
    exit 1
fi
echo "Rehearsal passed. Restoring this dump yields a database this code can run against."
echo "Note: sessions restore to their state at dump time, so anyone who signed in after it"
echo "      is signed out. See docs/runbooks/database-restore.md before a real restore."
