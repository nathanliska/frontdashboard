# Runbook: Restoring the Database

For the day the database is gone, corrupted, or a migration destroyed something. Read the whole
page before running anything — the order matters, and one step is irreversible.

Prod runs **PostgreSQL 17**, matching dev, test and CI. Dumps are taken by a sidecar in the Unraid
stack, not by anything in this repo, using the server's own `pg_dump` inside the container so client
and server versions can never disagree.

## Before you trust a dump

```sh
make restore-rehearsal DUMP=/path/to/dump.sql.gz
```

This restores into a throwaway container and asserts four things: the dump carries exactly one
Alembic revision, that revision is this checkout's head, `alembic check` finds no drift between the
models and the restored schema, and the `users` table is non-empty. It touches nothing real and
removes its container on exit.

**The `alembic check` assertion is the one that matters.** A dump can carry a correct revision stamp
over a schema that has lost a column — it passes a version comparison and fails here. A dump of the
wrong database restores cleanly and holds nothing, which is what the row check is for.

Accepts plain `.sql`, gzipped `.sql.gz`, and `pg_dump` custom format.

## Restoring for real

1. **Stop the backend.** Not the database — the backend, so nothing writes mid-restore.

   ```sh
   docker stop frontdashboard-backend
   ```

   By container name, as every step here does, so no compose file has to be found first. The stack
   the box runs is Compose Manager's, at `/mnt/user/appdata/stacks/frontdashboard/` — not this
   repo's. `restart: unless-stopped` is what makes the stop hold; `always` would race the restore.

2. **Take a dump of the current state first, however broken it looks.** It is the only copy of
   whatever happened between the last backup and now, and restoring over it is irreversible.

   ```sh
   docker exec frontdashboard-db pg_dump -U frontdashboard -d frontdashboard \
     > /mnt/user/appdata/backups/pre-restore-$(date +%Y%m%d-%H%M%S).sql
   ```

3. **Drop and recreate the database**, then load the dump. `psql` into `postgres`, not the target —
   you cannot drop a database you are connected to.

   ```sh
   docker exec frontdashboard-db psql -U frontdashboard -d postgres \
     -c "DROP DATABASE frontdashboard WITH (FORCE);" -c "CREATE DATABASE frontdashboard;"
   docker exec -i frontdashboard-db psql -U frontdashboard -d frontdashboard < dump.sql
   ```

   **Never `docker compose down -v`** to get a clean slate — that destroys the volume. Target the
   database, as above.

4. **Start the backend.** It runs `alembic upgrade head` on boot, so a dump older than the current
   schema migrates forward on the way up. Concurrent starts serialize on an advisory lock, so a
   restart mid-restore waits rather than racing.

   ```sh
   docker start frontdashboard-backend
   docker logs -f frontdashboard-backend
   ```

5. **Verify from outside**, read-only: the document is served, the bundle it names is `200`, and
   `/api/health/ready` answers.

## What a restore costs

- **Everyone is signed out** who signed in after the dump. Sessions are rows, not tokens
  ([ADR-003](../adr/ADR-003-first-class-sessions.md)), so restoring an older `sessions` table
  invalidates every cookie minted since. This is the most visible symptom and it is expected.
- **Open SSE streams break** and reconnect. Clients hand back a watermark that is now ahead of the
  restored log, which resolves to a full resync — correct, if briefly expensive.
- **Everything written after the dump is gone**: dashboards, lists, items, events, notifications.
  There is no partial merge, which is why step 2 exists.
- **The trash clock keeps its old readings.** A dashboard trashed before the dump resumes its
  30-day countdown from the original `deleted_at`, so a restore can be followed shortly by a purge
  ([ADR-007](../adr/ADR-007-soft-delete-boundary.md)).

## Open gaps

- **No off-host destination.** A copy on the machine that died is not a backup, and Unraid parity
  is not one either. Tracked as [#35](../TODO.md).
- **Backup restoration has been rehearsed, not performed.** The harness proves a dump is loadable
  and schema-correct; it does not prove the Unraid stack comes back up around it.
