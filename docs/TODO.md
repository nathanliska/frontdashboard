# FrontDashboard — Remediation Backlog

The live backlog of **open** work, distilled from the 2026-07-11 design review and its follow-up
passes. Findings keep their original numbers so older references still resolve.

Closed findings are **not** listed here — their execution detail is in git history, and the durable
decisions they established are captured in the [ADRs](adr/INDEX.md) / [FDRs](fdr/INDEX.md). Phases
1–3 (security quick wins, auth/session hardening, dashboard correctness) all shipped; see
[CONTEXT.md](../CONTEXT.md) for current behavior.

**Scale:** ~100 users, a few concurrent, one Compose stack, one backend worker. Operational machinery
that only pays off at fleet scale stays deferred — prefer the fix that deletes lines over the one that
adds a subsystem. (Scale is by replica, not by worker; `WEB_CONCURRENCY` is inert and only warns. Either
way a second process *breaks* SSE delivery until #45 lands, since fan-out is process-local. The ceilings that
actually bind first are the DB pool (`db_pool_size` + `db_max_overflow`, 10 connections) and the
Argon2 limiter (`argon2_max_concurrency`, 4) — both config, both raisable without new machinery.)

**Exposure:** public internet, registration open to anyone with a verifiable email. Abuse,
enumeration and data-privacy findings therefore do **not** get the small-deployment discount — any
stranger can become an authenticated user, so "only a logged-in user can reach it" is not a
mitigation on its own.

**Maintenance:** when an item ships, delete it here; if it set a cross-cutting decision, write/update
an ADR (or the relevant FDR) in the same change. New work appends with the next free number. Severity
and effort are noted inline where known.

## Phases

| Phase | Theme | Open findings |
|------:|-------|---------------|
| 5 | Infra / CI / ops | #33◐, #35◐, #34◐, #20◐ |
| — | Backlog (unscheduled) | #16◐, #39, #52, #56, #57, #58◐, #59, #60, #61, #64, #65, #21/#45 (Redis-gated) |

◐ = partially done; the line below states the remaining scope.

## Phase 5 — Infra / CI / ops

- **#33◐ — Move migrations out of application startup.** Done (2026-07-26): concurrent `alembic upgrade head` runs serialize on a session-scoped Postgres advisory lock in `alembic/env.py` — a restart mid-deploy now waits, sees head, and applies nothing, instead of racing the same DDL against itself (pinned by a two-subprocess test). Remaining: making migration a deliberate deploy step gated on a verified backup — that is #35's dependency, deferred with it. Startup-time migration itself is fine at one container; revisit with #21/#45 if process count ever grows. *(Small remaining, coupled to #35)*
- **#35◐ — Define & test backup/restore.** **Backups exist** (confirmed 2026-07-29): Postgres backups plus `pg_dump`s are being taken, which retires the original finding — that nothing backed the database up at all, and that losing the box lost every user's dashboards, lists and events. What remains is verification and procedure, not existence. Deploys run `alembic upgrade head` at container start ([#33](#)) against a migration history that has executed `DELETE`/`DROP TABLE`/`DROP COLUMN`, so the exposure is not only hardware. **Decided 2026-07-26 — the scheduled dump is a backup sidecar container in the Unraid stack, not a script in this repo**: this repo is never deployed to that box (only images are), so a script here would have to be hand-copied and hand-synced — automation in appearance only — and `pg_dump` of a database is not application-specific work. The rehearsal and the runbook have landed (2026-08-02): `make restore-rehearsal DUMP=…` restores into a throwaway container and asserts the dump carries one Alembic revision, that it is this checkout's head, that `alembic check` finds no drift between models and the restored schema, and that `users` is non-empty — each proven to fail independently against a deliberately broken dump. `alembic check` is the load-bearing one: a correct revision stamp over a schema missing a column passes a version comparison and fails there. [docs/runbooks/database-restore.md](runbooks/database-restore.md) carries the real procedure, including dumping the broken state *before* overwriting it and the fact that restoring an older `sessions` table signs out everyone who logged in since. Facts already established: prod runs **PostgreSQL 17** (matches dev/test/CI), dumps should be taken with the server's own `pg_dump` inside the container so client and server versions can never disagree, and a flat ~180-day retention is nearly free at this data size — tiering buys nothing. Still open, and both need the box rather than this repo: an **off-host destination** (a copy on the machine that died is not a backup, and Unraid parity is not one either), and running the rehearsal against a **real production dump** — everything so far has been proven against synthetic ones, so the harness is trusted and the actual backups are not yet. *(Small remaining — harness done, the two gaps are operational)*
- **#34◐ — Deploy a matched pair of images (2026-08-02).** Prod pulls the mutable `latest`, so the two manifest writes that move it are a window in which a `pull` can take a new frontend against an old backend — the one runtime failure the contract gate can't catch ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). **Keeping `latest` remains deliberate**: it is the Unraid convention, and Compose Manager's check-and-update is the deploy. Publishing is CI's alone now. Both images build and load before anything is pushed, both `:<short-sha>` tags go up before either `latest` moves, and nothing publishes unless the whole suite is green — so no failure order can leave the two tags describing different commits, and a `main` run is never cancelled mid-publish. `deploy.sh` is gone and the compose file reads `ghcr.io/nathanliska/*`; building locally and pushing by hand was the last path that skipped every gate. See [docs/runbooks/rollback.md](runbooks/rollback.md), which also records the part a tag cannot fix: an image rollback does not undo a migration, and a destructive one makes rolling back worse than going forward. **Not retroactive** — only builds pushed since carry a sha, and none of the Docker Hub ones came from GHCR. Remaining is one step on the box: the packages stay **private** (decided 2026-08-04), so the host needs `docker login ghcr.io` with a `read:packages` token before its first pull. Closing the window entirely would mean pinning a sha, which `${TAG}` already supports and the runbook already uses. *(Small remaining — one login on the host)*
- **#20◐ — Test against Alembic's deployed schema.** Done: shared fixture upgrades through the full chain, a test runs `alembic check` + heads check, `create_all` gone, notification FK reconciled. Remaining: an upgrade test from a prior data snapshot — pairs naturally with #35's dumps. *(Small)*

## Backlog (unscheduled)

- **#16◐ — Make calendar work proportional to the requested window (2026-07-27).** The original finding overstated the expander: daily and weekly series without a `count` already skip ahead to near `window_start`, and monthly/yearly do iterate from series start but at 12 and 1 steps per year, against a window capped at 366 days. The real waste was in the router, which loaded **every** non-deleted event on every accessible dashboard with no window predicate. Done: one-off events are bounded by their own times; recurring ones by `starts_at` and, where the rule carries `until`, by `until + duration` read straight from the JSONB — so a finished or not-yet-started series never reaches Python. `update_event` deletes occurrence overrides when a series is made one-off. **A persisted last-occurrence column was considered and rejected** ([FDR-006](fdr/FDR-006-calendar-and-events.md)): it must be recomputed on any change to `starts_at`/`ends_at`/`timezone`/`recurrence`, and one missed recomputation silently hides events — a correctness risk traded for speed nothing is waiting on. Remaining, and only worth it if a calendar is ever actually slow: series with a `count` limit and no `until` still load unbounded (finding their end means expanding the rule, which is the work being avoided), and the predicate is a filter rather than an index seek. *(Small remaining, no trigger yet)*
- **#39 — Extract use cases from the dashboard router.** 1,139 lines coupling validation, authz, persistence, activity, notification and SSE, repeating the same transaction/broadcast dance in every handler. Worth doing as the deletion it implies — one unit of work + staged outbox, routers as thin adapters — not as a speculative layer. *(Large)*
- **#52 — SSE overflow eviction is attacker-inducible (Low).** A co-member driving >256 rapid mutations can pin a victim in a reconnect/resync/refetch loop. Stays low even under open registration: it isn't a silent deafen, and reaching a victim requires holding an invite link to a dashboard they share, so a stranger who merely signs up cannot trigger it. Coalesce evictions into a single resync and cap resyncs per connection if it ever shows up in practice. *(Medium)*
- **#21 / #45 — Replica readiness (maintained; routing is what remains).** **The shared state is done; nothing process-local blocks a replica any more.** `sse/manager.py` still holds its clients in a list private to one event loop — worker A cannot reach a client attached to worker B, and no load-balancer trick defers that, since per-user affinity still fails when a shared dashboard fans out to *other* users who land on other workers. A Redis stream now carries frames between workers (2026-08-07), which is what closed it. Two properties kept the fix a swap rather than a rewrite, and both are stated as invariants in [ADR-004](adr/ADR-004-sse-over-websocket.md) so they don't rot: fan-out has **exactly one choke point** for writes, test-enforced (routers call `commit_and_broadcast`, the only caller of `manager.broadcast` besides the fan-out reader, which re-delivers a sibling's already-committed frame; only the consumer in `routers/sse.py` touches a queue), and resync is **ordering-free** (a reconnect's mark decides only *whether* to resync; a resync refetches everything rather than replaying `activity_events`). So the backplane needs **at-least-once delivery only** — no ordering, no exactly-once, no distributed log. **Redis** carries it (standardised 2026-08-04, [ADR-004](adr/ADR-004-sse-over-websocket.md)): `LISTEN/NOTIFY` clears that bar on its own, but a replica also needs a shared rate-limit store, and `limits` 5.8 offers memory / memcached / mongodb / redis / valkey and no Postgres — so Redis is required regardless, and one backplane beats two. Everything else is arithmetic, not work: each worker opens its own pool, so connections are N × (`db_pool_size` + `db_max_overflow`) against Postgres `max_connections`, and peak Argon2 memory is N × `argon2_max_concurrency` × 64 MiB. **The shared limit store landed first (2026-08-06)** — it was the one item with an ordering constraint, since registration is open to the internet and silently multiplying every abuse limit by N is a security regression rather than a scaling detail, so it could not wait for the replica that would expose it. Buckets are in Redis, with a per-process in-memory fallback while Redis is unreachable ([ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md)). **Fan-out followed (2026-08-07)**: a stream rather than pub/sub, read from the last id each worker saw, publishing local-first and never raising, with a resync on reader recovery covering whatever the stream could not. **Already cluster-safe:** session auth (resolved from Postgres, no per-process token state), the reaper (`pg_try_advisory_xact_lock`, so N schedulers still run one sweep per tick), startup migrations (#33), and stream revocation — `drop_session_streams` is a latency optimisation with the 30s revalidation as the guarantee, which deliberately keeps the single-worker assumption out of the security argument. **Open gap:** `Caddyfile.prod` proxies a static `frontdashboard-backend:8000`, so a second replica would take no traffic until that becomes a dynamic A-record upstream with `lb_policy` — `dynamic a` wants an explicit `resolvers 127.0.0.11` for Docker's embedded DNS, and `docker-compose.verify.yml` can exercise it at `--scale backend=2`. Note **active health checks do not run against a dynamic upstream** (Caddy's own docs), so `health_uri` would be inert there and passive checks (`fail_duration`) are what actually apply; the default `refresh` is 1m, so a new replica waits up to a minute for traffic. Left unbuilt because it enables nothing before the backplane and shares the same trigger; `container_name` on the backend service stays for the same reason, and measured on Compose v5.1.0 it is a real interlock rather than an assumed one: `--scale` exits 1 having started nothing, and `deploy.replicas` alongside it is rejected as `invalid compose project` before anything runs. That second one is the case that matters here — Unraid deploys by button, so **`deploy.replicas` in the file is the scaling lever on that box, not `--scale`**, and it is honoured by plain `docker compose up` (measured: 3 containers, exit 0). Not scheduled, but not deferred: the invariants above are maintained so this stays a swap, and the trigger is the first replica rather than a date. *(Medium — one method, plus the seam that keeps it one method)*
- **#61 — No per-user resource quota (2026-07-29).** A verified account can create unlimited dashboards, lists, items and events. Rate limits now bound the *rate* of writes (`WRITE_LIMIT`, 300/min per client IP, asserted on every mutating route by `test_rate_limit_coverage.py`) but deliberately not the *total*: a patient script stays under any sane rate limit forever, so this is the tool for volume and rate limiting is not. It bites more than it looks because `activity_events` and `notifications` are pruned at 90 days while **lists, items, events and dashboards have no horizon at all** — trash only reclaims what someone chose to delete, so the growth is permanent. Not urgent: it is Postgres data on a box with backups, and the realistic abuser has to verify an email per account. The decisions to settle before writing any of it are product ones, not technical — what the numbers are, what the error says, and what happens to an existing user who is already over a newly-introduced cap (grandfathering beats a dashboard nobody can open). *(Small once the numbers are decided)*
- **#56 — Account deletion: wanted, unbuilt, and the schema already pretends otherwise (2026-07-28).** `User.deleted_at` exists on the model and is filtered in 8 places across 4 modules, but **nothing anywhere sets it** — there is no delete-my-account route. So the column reads like a feature that exists, and the filters cost a predicate on every user lookup for one that does not. Unlike the list/calendar `/shares` endpoints — which are **deliberate 409 stubs never to be implemented** because sharing is dashboard-managed — this one is genuinely wanted: registration is open to the internet, so someone who signs up should be able to leave. What it needs, and why it is more than a `DELETE` route: every `NOT NULL` FK to `users.id` blocks the row (`lists.created_by`/`updated_by`, `list_items.created_by`/`updated_by`/`assigned_to`, `calendar_events.created_by`/`updated_by`, `calendar_event_overrides.created_by`/`updated_by`, `resource_shares.granted_by`, `dashboards.user_id`) — none carry `ON DELETE`, and `assigned_to` blocks despite being nullable. `reap_abandoned_signups` enumerates exactly that set and sidesteps it by refusing to purge anyone referenced; a real deletion has to *resolve* each one instead — reassign authorship to the dashboard owner, or anonymise the account rather than remove the row. The decision to make first is which of those two it is, because soft-delete-then-reap and anonymise-in-place want different schemas. Blocked in practice on **#57**: an owner deleting their account today would take every dashboard they own with it, including ones other people depend on, so there has to be somewhere for ownership to go first. *(Medium)*
- **#57 — Dashboard ownership cannot be transferred (2026-07-28).** Owner is `dashboards.user_id`, and owner is modelled as the *absence* of a share ([ADR-001](adr/ADR-001-per-resource-sharing.md)), so a transfer is three coupled writes rather than one: move `user_id`, delete the new owner's `resource_shares` row, and add one for the old owner if they are to keep access. Nothing can do it today, which means **a shared household dashboard dies with whoever happened to create it** — and it is what blocks account deletion (#56) from being safe. Design decisions to settle: whether the old owner is demoted to editor or dropped entirely, whether the new owner must already be a share principal (probably yes — it avoids inviting and promoting in one unreviewable step), and what happens to `resource_shares.granted_by` rows the old owner issued (they are NOT NULL with no `ON DELETE`, so they pin the account either way). *(Medium)*
- **#58◐ — Losing access to a shared dashboard (2026-08-01).** Both silent paths now notify. Share removal already did, contrary to the original finding — `delete_dashboard_share` has staged a `"removed"` notification through the same helper as the *added* case for some time. Trashing did not, and now does ([FDR-007](fdr/FDR-007-notifications-and-activity.md) §5): `DELETE /dashboards/{id}` stages `dashboard.deleted` for every user principal but the actor, and the frontend routes both that type and `share_removed` to the dashboard index rather than a `reference_id` that would 404. Remaining, both genuine questions rather than missing code: whether a shared user should be warned **again before the purge**, since `trash_retention_days` later the reaper takes the cascade *including lists and events they authored themselves*, and whether they should get any route back at all — restore is owner-only, so the notification explains the loss without offering a remedy. Related and cheap: an editor can act on a dashboard but cannot see **who else** has access, which may be deliberate or merely unbuilt — worth deciding rather than leaving ambiguous. *(Small remaining, product decisions first)*
- **#59 — Changing an email address is unbuilt (2026-07-28).** The profile page edits a display name and nothing else, so an address entered at signup is permanent — which matters more than it sounds, because the case-insensitive unique index reserves it forever and there is no account deletion (#56) to release it. Constraints the implementation has to respect: the new address must be **verified before the switch**, never after, or a typo locks the account out permanently with no recovery path; the **old** address should be notified, since that is how a user detects a takeover; and it needs a pending-change record (new address + token) distinct from `email_verification_tokens`, which means something else. The trap worth writing down: an obvious "that address is already in use" response **reintroduces the enumeration oracle** that [ADR-011](adr/ADR-011-enumeration-safe-login.md) closed — registration deliberately answers identically for known and unknown addresses, and this flow has to as well, always saying "check your new address" and silently doing nothing when taken. *(Medium)*
- **#60 — No session-management UI, and the columns for one sit empty (2026-07-28).** `sessions`
  has `device_name`, `ip_hash` and `user_agent_hash`; **nothing writes any of them**, and that is
  deliberate rather than an oversight — with no screen to read them, populating them would mean
  collecting client IPs for nobody. It matters more now than it did: dropping refresh-token
  rotation ([ADR-003](adr/ADR-003-first-class-sessions.md)) removed the only mechanism that would
  ever have signalled a **copied session cookie**, and the honest replacement is letting a person
  see their own live sessions and revoke one. The machinery underneath already exists —
  `revoke_session` is the single choke point every path routes through, and `drop_session_streams`
  tears down SSE immediately — so this is a list endpoint, a revoke endpoint and a settings panel,
  not new auth work. Two things to settle first: `ip_hash` needs a **keyed** hash (a plain SHA-256
  of an IPv4 is brute-forceable in seconds, so it would not be an anonymisation at all), and
  `device_name` has no trustworthy source — a parsed User-Agent is a guess, and letting people
  name their own devices is honest but needs the UI anyway. *(Small-Medium)*


## Deferred — revisit when

Capabilities deliberately not built yet. Listed with the condition that would make them worth the
weight, so the reasoning survives and nothing here has to be re-derived later.

- **Tracing and structured logging** — when a problem survives a session of reading logs by hand.
  Counters shipped (`/metrics`, see CONTEXT.md) because decisions about worker count, pool size and
  whether reconnect marks help were being made from reasoning rather than measurement; per-request
  tracing is a different weight and still answers no question being asked.
- **Exporters for the infrastructure we don't own** (`redis_exporter`, `postgres_exporter`) — when a
  reading we already have starts prompting a question about the service underneath it. The split is
  the standard one and worth stating, because it decides where every future metric goes: an app
  instruments *itself*, and an exporter exists only to translate software you cannot modify. So
  `/metrics` is the right home for anything the backend knows, and these two are the only sidecars
  the stack would ever grow. What they'd add that self-instrumentation structurally cannot:
  `redis_exporter` sees `used_memory` against the 64 MiB cap, evictions, `connected_clients` and
  keyspace size — the fan-out stream's real cost, which the app only ever sees as "the publish
  worked"; `postgres_exporter` sees `max_connections` occupancy across *all* clients, which is the
  ceiling replicas run into and which our own pool gauges, being per-process, cannot report. Grafana
  dashboards 763 and 14091 cover the Redis half with no authoring. Deliberately not now: Redis holds
  rate-limit counters and a `MAXLEN`-capped stream, both of which expire on their own, and one
  replica cannot exhaust a hundred connections — so both exporters would be watching a number that
  cannot move. Neither is blocked on anything; they are one compose service and one scrape target
  each, on a box whose Prometheus config this repo does not hold.
- **SBOM + release signing** — when there are external contributors, redistribution, or a compliance ask.
- **Dependency/SAST/secret/image scanning in CI** — when the app stores anything beyond calendars,
  lists and dashboards, or when contributors outnumber one. Dependabot + `osv-scanner` cover the
  realistic case now.
- **Browser/a11y regression tests (Playwright + axe)** — #27 landed, so the primitives now exist
  (`ui/Dialog`, `ui/OverflowMenu`, `ui/FormField`, the confirm dialog and the live-region toaster)
  and each is unit-tested for its accessible wiring. What's still missing is *cross-component*
  coverage in a real browser — focus order across a page, a full keyboard traversal, contrast. Worth
  it when a regression actually slips through the unit tests, or when the component set grows past
  what a person can re-check by hand.
- **Container hardening beyond non-root + digest pinning** (read-only fs, tmpfs, dropped caps,
  `no-new-privileges`, resource/PID limits) — when the origin is reachable outside the Cloudflare
  Tunnel, or when it runs untrusted workloads.
- **Dropping runtime response validation** — the generated types are free; the runtime half is
  ~14.5 kB gzip of the main chunk (376 kB / 109 kB gzip, up from 311 kB). Revisit if bundle size
  ever outweighs the guarantee — generating types without a runtime is a one-flag change
  ([ADR-018](adr/ADR-018-generated-validated-contracts.md)).
- **Multi-process / horizontal scale** — see #21/#45. The axis is **replicas, not uvicorn workers**:
  forked workers share one listening socket, so a `/metrics` scrape reaches an arbitrary one and
  every counter reads as resetting, while `prometheus_client`'s multiprocess mode reports 0 for
  each of the nine `set_function` gauges. A replica is its own scrape target and needs neither.
  `WEB_CONCURRENCY` is therefore inert and only warns. The shared state has landed — a shared limit
  store and a shared fan-out, both on Redis, since `limits` has no Postgres backend and the limiter
  forces Redis either way. Measured headroom on one
  process: ~150-250 req/s with no failures at 50 concurrent and ~10 ms per request, against a real
  load of a few per second — so this is readiness, not need. Scaling additionally needs
  `container_name` dropped from the backend service, Caddy moved to a dynamic A-record upstream with
  `lb_policy`, and Prometheus moved to DNS service discovery — the scrape config lives on the box,
  not in this repo, so that one is an Unraid edit rather than a commit. The knob is `deploy.replicas`
  rather than `--scale`: Compose honours it on a plain `up` (measured, v5.1.0), and Compose Manager
  offers no place to pass a flag.
  **Postgres is the ceiling nobody has had to think about yet**: each replica opens its own pool, so
  N × (`db_pool_size` + `db_max_overflow`) = 10N against a default `max_connections` of 100 caps
  this at ~8 replicas by arithmetic alone. Manual scaling stays inside that; anything *auto*matic
  wants PgBouncer first, or an autoscaler chasing a spike scales into a database outage — which
  fails harder than being slow. The dashboards
  in `observability/` already aggregate across replicas, so they need no change when this lands.
  The one thing they cannot show is a *distinct* count of the people or devices holding streams:
  set cardinality is per-process and does not sum, so it needs the backplane to know the global
  set. Gauges for it were tried and removed (2026-08-04) rather than shipped reading as a floor —
  worth building alongside the backplane, not before it.

- **SSE replay of event bodies from the activity log** — gap *detection* has shipped (FDR-008 §5):
  a reconnect hands back its mark and skips the resync when the log has not moved, which covers
  deploys, where no events can occur at all. Replaying the bodies is what remains, and it only pays
  off when events *did* occur — a long disconnect, or `_QUEUE_MAX` eviction, both of which still
  resync wholesale. Three constraints, none of which detection had to meet: the audience must be
  recomputed at replay time via `list_accessible_dashboard_ids` (a share revoked while disconnected
  must not become replayable); no index fits `event_id > :last AND dashboard_id IN (…)`, so bound
  the replay and fall back to resync rather than add an expression index the reaper's design
  deliberately avoids; and `event_id` is assigned at flush, so it orders assignments rather than
  commits — replaying by it inherits the gap FDR-008 §5 records, which wants a commit-ordered
  stream id first.

- **#65 — Occurrence expansion is bounded per event, not per request (2026-08-07).** `GET /calendar/events` loads every event that could land in the window and expands each in pure Python on the event loop. Both per-event axes are bounded — the window is capped at 366 days with a 422 past it, `interval` is `1..366` and `count` is `≤ 1000` — so one series costs at most a few hundred iterations of `ZoneInfo` arithmetic. **The number of events is the axis nothing caps**: the query has no `LIMIT`, so the work is `events × iterations`, and a dashboard set holding thousands of recurring events makes one GET expensive. Same shape as #61 and blocked on the same decision — a quota is the tool for volume, and picking the number is a product call. Worth measuring before building anything: at today's event counts this is arithmetic, not a symptom, and `frontdashboard_http_request_seconds` on `/api/calendar/events` is where it would first show. *(Small once #61's numbers are settled)*
- **#64 — The rate limiter blocks the event loop while Redis is unreachable (2026-08-06).** slowapi 0.1.10 has a single `Limiter` and imports only `limits.storage`, never the `limits.aio.storage` that `limits` 5.8 ships — so its Redis client is synchronous and `strategy.hit()`, called per rate-limited request, runs on the event loop. Healthy that costs **0.50ms p50 / 0.73ms p99**, which is why it has never shown. Against a stopped Redis container it took **7.68-7.70s**, and a ticker task alongside proved the loop frozen for the whole of it (0.50s call → 0.52s largest tick gap on a blackholed address). The unit of damage is therefore a stalled worker, not a slow write: concurrent requests, open SSE streams and `/api/health/ready` all wait it out, and the container health check allows 5s, so a check landing in a stall fails — a wrong health signal, though not a restart loop, since Compose does not restart on unhealthy. No configuration reaches it and `asyncio.wait_for` cannot either, a timeout callback being unable to fire on a frozen loop. The fix is dropping slowapi for `limits.aio` directly, which also costs the `@limiter.limit` decorator and `test_rate_limit_coverage.py` that enforces it — so it wants a trigger. That trigger is Redis restarting often enough to notice, or a second replica making a stalled worker cost more than a slow write. *(Medium, no trigger yet — [ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md))*
- **#63 — `test_the_liveness_predicate_is_shared` failed once, unreproduced (Low).** One full-suite
  run had `resolve_session` treat a session as expired while `session_is_live` still called it live,
  at the `session_idle_days + 1s` boundary. Did not recur across three isolated runs, three file
  runs and four full runs. Both paths take their own `datetime.now(UTC)` and splat the same `_live`
  predicate, so a transaction-clock skew was ruled out; the mechanism is unknown. Worth a fixed
  clock injected into `_live` rather than two independent `now()` reads, which would make the
  question unaskable. *(Small)*

## Accepted risks / won't-do

- *(none open — register enumeration was closed by #55 rather than accepted; registration now
  answers identically for known and unknown addresses. See
  [ADR-011](adr/ADR-011-enumeration-safe-login.md).)*
