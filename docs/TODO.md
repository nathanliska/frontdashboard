# FrontDashboard — Remediation Backlog

The live backlog of **open** work, distilled from the 2026-07-11 design review and its follow-up
passes. Findings keep their original numbers so older references still resolve.

Closed findings are **not** listed here — their execution detail is in git history, and the durable
decisions they established are captured in the [ADRs](adr/INDEX.md) / [FDRs](fdr/INDEX.md). Phases
1–3 (security quick wins, auth/session hardening, dashboard correctness) all shipped; see
[CONTEXT.md](../CONTEXT.md) for current behavior.

**Scale:** ~100 users, a few concurrent, one Compose stack, one backend worker. Operational machinery
that only pays off at fleet scale stays deferred — prefer the fix that deletes lines over the one that
adds a subsystem. (One worker is not a limitation to route around: SSE fan-out is process-local, so
adding workers *breaks* delivery until #45 lands. The ceilings that actually bind first are the DB
pool (`db_pool_size` + `db_max_overflow`, 10 connections) and the Argon2 limiter
(`argon2_max_concurrency`, 4) — both config, both raisable without new machinery.)

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
| 4 | Data layer, contracts & exposure | #24◐ |
| 5 | Infra / CI / ops | #33, #35, #34, #20◐ |
| — | Backlog (unscheduled) | #16, #19◐, #39, #52, #21/#45 (deferred) |

◐ = partially done; the line below states the remaining scope.

## Phase 4 — Data layer, contracts & exposure

- **#24◐ — Request-cache consolidation (premise corrected 2026-07-25).** The original finding read four in-flight implementations as one thing implemented four ways. Reading them, that isn't true, and the "adopt TanStack Query, delete ~330 lines" plan would have deleted the working code and kept the messy code. What each actually is: `api/client.ts`'s `refreshPromise` is a **token-refresh mutex, not a cache** — no query library replaces it, it stays. `resources/scopedQuery.ts` (234 lines, tested, serving five queries) is a competent keyed cache with in-flight dedup, staleness and subscriptions — it is the thing a library would replace, i.e. the wrong target. The dashboard store's coalescing **is not duplication either**: `loadDashboard` merges `background`/`surfaceAccessLoss` across a queued follow-up so a real navigation upgrades an in-flight background refetch and still evicts on 403 — `scopedQuery.fetch` discards new options when a request is already running, so moving it there would either lose that or push supersession into the primitive the other five queries use cleanly. Done: deleted the genuinely redundant single-flight `Map` for dashboard detail (its only caller coalesces above it); the share-read `Map` stays, documented — the settings modal fetches from an effect with no coalescing above it and StrictMode double-invokes it. Remaining, and the only real gap: **`scopedQuery` entries are never evicted**, so a long-lived tab scrolling the calendar accumulates one entry per window until logout. Bounded and small — fix it with a TTL sweep when it justifies the timer, not before. Revisit the library question only if #22's cursor becomes real pagination, which is the shape that would earn it. *(Small)*

## Phase 5 — Infra / CI / ops

- **#33◐ — Move migrations out of application startup.** Done (2026-07-26): concurrent `alembic upgrade head` runs serialize on a session-scoped Postgres advisory lock in `alembic/env.py` — a restart mid-deploy now waits, sees head, and applies nothing, instead of racing the same DDL against itself (pinned by a two-subprocess test). Remaining: making migration a deliberate deploy step gated on a verified backup — that is #35's dependency, deferred with it. Startup-time migration itself is fine at one container; revisit with #21/#45 if process count ever grows. *(Small remaining, coupled to #35)*
- **#35 — Define & test backup/restore.** Still the most valuable item in this file: **nothing backs the database up today**, confirmed 2026-07-26 — no dumps, and the Unraid appdata backup neither covers Postgres nor stops the container (a file copy of a running Postgres data directory is not a restorable backup). If that box dies, every user's dashboards, lists and events are gone. Deploys run `alembic upgrade head` at container start ([#33](#)) against a migration history that has executed `DELETE`/`DROP TABLE`/`DROP COLUMN`, so the exposure is not only hardware. **Decided 2026-07-26 — the scheduled dump is a backup sidecar container in the Unraid stack, not a script in this repo**: this repo is never deployed to that box (only images are), so a script here would have to be hand-copied and hand-synced — automation in appearance only — and `pg_dump` of a database is not application-specific work. What *does* belong here when it lands: a **restore rehearsal** (restore into a scratch Postgres, assert `alembic_version` matches the repo head and the schema is one the app can run against) and the runbook, including that a restore resets `sessions` so everyone is logged out. Facts already established: prod runs **PostgreSQL 17** (matches dev/test/CI), dumps should be taken with the server's own `pg_dump` inside the container so client and server versions can never disagree, and a flat ~180-day retention is nearly free at this data size — tiering buys nothing. Still unknown: **an off-host destination**. A copy on the machine that died is not a backup, and Unraid parity is not one either. *(Medium)*
- **#34 — Deploy a matched pair of images (deferred by decision, 2026-07-26).** Both images deploy as mutable `latest`, so a partial push can leave a new frontend talking to an old backend — the one runtime failure the contract gate can't catch ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). **Keeping `latest` was chosen deliberately**; the deploy flow stays as it is. The consequence to be aware of rather than surprised by: pushing moves the tag, which leaves the previous build unnamed and eligible for garbage collection, so **there is currently nothing to roll back *to*** — recovering a bad deploy means rebuilding from an older commit. The cheap half of this finding, if that ever bites, is emitting an immutable `:<sha>` tag alongside `latest` in `deploy.sh` (deploy commands unchanged, one extra push per image); pinning the pair together is the larger half. *(Small-Medium)*
- **#20◐ — Test against Alembic's deployed schema.** Done: shared fixture upgrades through the full chain, a test runs `alembic check` + heads check, `create_all` gone, notification FK reconciled. Remaining: an upgrade test from a prior data snapshot — pairs naturally with #35's dumps. *(Small)*

## Backlog (unscheduled)

- **#16 — Make calendar work proportional to the requested window.** A window request loads every active event for every accessible dashboard, expands recurrence in Python, and sorts globally; monthly/yearly rules iterate from series start. The cheap half — split recurring/non-recurring SQL, index it, persist recurrence bounds, window-filter overrides — is worth doing when the calendar is actually slow. *(Medium)*
- **#19◐ — Validate share targets, atomic upserts.** Done: reject self / nonexistent / deleted / unverified targets; duplicate initial targets rejected at the schema; `create_share` is one `INSERT … ON CONFLICT DO UPDATE` on `uq_resource_shares_target` instead of a read-then-insert that raced itself into a 500 (only the role is upserted — `granted_by`/`created_at` stay with the original grant). Remaining: user/dashboard FKs on `resource_shares` — `resource_id` is polymorphic, so a real FK needs a schema decision (per-type share tables or a checked pair of typed columns) that #18's consolidation deliberately did not make ([ADR-001](adr/ADR-001-per-resource-sharing.md) keeps the polymorphic table). *(Small, blocked on that decision)*
- **#39 — Extract use cases from the dashboard router.** 1,139 lines coupling validation, authz, persistence, activity, notification and SSE, repeating the same transaction/broadcast dance in every handler. Worth doing as the deletion it implies — one unit of work + staged outbox, routers as thin adapters — not as a speculative layer. *(Large)*
- **#52 — SSE overflow eviction is attacker-inducible (Low).** A co-member driving >256 rapid mutations can pin a victim in a reconnect/resync/refetch loop. Stays low even under open registration: it isn't a silent deafen, and reaching a victim requires holding an invite link to a dashboard they share, so a stranger who merely signs up cannot trigger it. Coalesce evictions into a single resync and cap resyncs per connection if it ever shows up in practice. *(Medium)*
- **#21 / #45 — Multi-process readiness (deferred).** Auth authority is already cluster-safe (sessions in Postgres, worker-agnostic revocation). Process-local SSE fan-out (needs a pub/sub backplane — the real blocker), per-process rate-limit buckets, startup-migration races (#33) and pool multiplication are not. No scaling need at household scale; recorded so the pieces are known, not queued. *(Large)*

## Deferred — revisit when

Capabilities deliberately not built yet. Listed with the condition that would make them worth the
weight, so the reasoning survives and nothing here has to be re-derived later.

- **Metrics, tracing, structured logging** — when one worker stops being enough, or when a problem
  survives a session of reading logs by hand. Today it would mean running a metrics stack to observe
  a few concurrent users.
- **SBOM + release signing** — when there are external contributors, redistribution, or a compliance ask.
- **Dependency/SAST/secret/image scanning in CI** — when the app stores anything beyond calendars,
  lists and dashboards, or when contributors outnumber one. Dependabot + `npm audit` cover the
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
- **Multi-worker / horizontal scale** — see #21/#45. Needs an SSE backplane first; the DB pool and
  Argon2 limiter are the ceilings that bind before process count does, and both are settings.

## Accepted risks / won't-do

- *(none open — register enumeration was closed by #55 rather than accepted; registration now
  answers identically for known and unknown addresses. See
  [ADR-011](adr/ADR-011-enumeration-safe-login.md).)*
