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
| 5 | Infra / CI / ops | #33, #35, #34, #20◐ |
| — | Backlog (unscheduled) | #16◐, #39, #52, #21/#45 (deferred) |

◐ = partially done; the line below states the remaining scope.

## Phase 5 — Infra / CI / ops

- **#33◐ — Move migrations out of application startup.** Done (2026-07-26): concurrent `alembic upgrade head` runs serialize on a session-scoped Postgres advisory lock in `alembic/env.py` — a restart mid-deploy now waits, sees head, and applies nothing, instead of racing the same DDL against itself (pinned by a two-subprocess test). Remaining: making migration a deliberate deploy step gated on a verified backup — that is #35's dependency, deferred with it. Startup-time migration itself is fine at one container; revisit with #21/#45 if process count ever grows. *(Small remaining, coupled to #35)*
- **#35 — Define & test backup/restore.** Still the most valuable item in this file: **nothing backs the database up today**, confirmed 2026-07-26 — no dumps, and the Unraid appdata backup neither covers Postgres nor stops the container (a file copy of a running Postgres data directory is not a restorable backup). If that box dies, every user's dashboards, lists and events are gone. Deploys run `alembic upgrade head` at container start ([#33](#)) against a migration history that has executed `DELETE`/`DROP TABLE`/`DROP COLUMN`, so the exposure is not only hardware. **Decided 2026-07-26 — the scheduled dump is a backup sidecar container in the Unraid stack, not a script in this repo**: this repo is never deployed to that box (only images are), so a script here would have to be hand-copied and hand-synced — automation in appearance only — and `pg_dump` of a database is not application-specific work. What *does* belong here when it lands: a **restore rehearsal** (restore into a scratch Postgres, assert `alembic_version` matches the repo head and the schema is one the app can run against) and the runbook, including that a restore resets `sessions` so everyone is logged out. Facts already established: prod runs **PostgreSQL 17** (matches dev/test/CI), dumps should be taken with the server's own `pg_dump` inside the container so client and server versions can never disagree, and a flat ~180-day retention is nearly free at this data size — tiering buys nothing. Still unknown: **an off-host destination**. A copy on the machine that died is not a backup, and Unraid parity is not one either. *(Medium)*
- **#34 — Deploy a matched pair of images (deferred by decision, 2026-07-26).** Both images deploy as mutable `latest`, so a partial push can leave a new frontend talking to an old backend — the one runtime failure the contract gate can't catch ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). **Keeping `latest` was chosen deliberately**; the deploy flow stays as it is. The consequence to be aware of rather than surprised by: pushing moves the tag, which leaves the previous build unnamed and eligible for garbage collection, so **there is currently nothing to roll back *to*** — recovering a bad deploy means rebuilding from an older commit. The cheap half of this finding, if that ever bites, is emitting an immutable `:<sha>` tag alongside `latest` in `deploy.sh` (deploy commands unchanged, one extra push per image); pinning the pair together is the larger half. *(Small-Medium)*
- **#20◐ — Test against Alembic's deployed schema.** Done: shared fixture upgrades through the full chain, a test runs `alembic check` + heads check, `create_all` gone, notification FK reconciled. Remaining: an upgrade test from a prior data snapshot — pairs naturally with #35's dumps. *(Small)*

## Backlog (unscheduled)

- **#16◐ — Make calendar work proportional to the requested window (2026-07-27).** The original finding overstated the expander: daily and weekly series without a `count` already skip ahead to near `window_start`, and monthly/yearly do iterate from series start but at 12 and 1 steps per year, against a window capped at 366 days. The real waste was in the router, which loaded **every** non-deleted event on every accessible dashboard with no window predicate. Done: one-off events are bounded by their own times; recurring ones by `starts_at` and, where the rule carries `until`, by `until + duration` read straight from the JSONB — so a finished or not-yet-started series never reaches Python. `update_event` deletes occurrence overrides when a series is made one-off. **A persisted last-occurrence column was considered and rejected** ([FDR-006](fdr/FDR-006-calendar-and-events.md)): it must be recomputed on any change to `starts_at`/`ends_at`/`timezone`/`recurrence`, and one missed recomputation silently hides events — a correctness risk traded for speed nothing is waiting on. Remaining, and only worth it if a calendar is ever actually slow: series with a `count` limit and no `until` still load unbounded (finding their end means expanding the rule, which is the work being avoided), and the predicate is a filter rather than an index seek. *(Small remaining, no trigger yet)*
- **#39 — Extract use cases from the dashboard router.** 1,139 lines coupling validation, authz, persistence, activity, notification and SSE, repeating the same transaction/broadcast dance in every handler. Worth doing as the deletion it implies — one unit of work + staged outbox, routers as thin adapters — not as a speculative layer. *(Large)*
- **#52 — SSE overflow eviction is attacker-inducible (Low).** A co-member driving >256 rapid mutations can pin a victim in a reconnect/resync/refetch loop. Stays low even under open registration: it isn't a silent deafen, and reaching a victim requires holding an invite link to a dashboard they share, so a stranger who merely signs up cannot trigger it. Coalesce evictions into a single resync and cap resyncs per connection if it ever shows up in practice. *(Medium)*
- **#21 / #45 — Multi-process readiness (deferred).** Auth authority is already cluster-safe (sessions in Postgres, worker-agnostic revocation). Process-local SSE fan-out (needs a pub/sub backplane — the real blocker), per-process rate-limit buckets, startup-migration races (#33) and pool multiplication are not. No scaling need at household scale; recorded so the pieces are known, not queued. *(Large)*
- **#56 — Account deletion: wanted, unbuilt, and the schema already pretends otherwise (2026-07-28).** `User.deleted_at` exists on the model and is filtered in 8 places across 4 modules, but **nothing anywhere sets it** — there is no delete-my-account route. So the column reads like a feature that exists, and the filters cost a predicate on every user lookup for one that does not. Unlike the list/calendar `/shares` endpoints — which are **deliberate 409 stubs never to be implemented** because sharing is dashboard-managed — this one is genuinely wanted: registration is open to the internet, so someone who signs up should be able to leave. What it needs, and why it is more than a `DELETE` route: every `NOT NULL` FK to `users.id` blocks the row (`lists.created_by`/`updated_by`, `list_items.created_by`/`updated_by`/`assigned_to`, `calendar_events.created_by`/`updated_by`, `calendar_event_overrides.created_by`/`updated_by`, `resource_shares.granted_by`, `dashboards.user_id`) — none carry `ON DELETE`, and `assigned_to` blocks despite being nullable. `reap_abandoned_signups` enumerates exactly that set and sidesteps it by refusing to purge anyone referenced; a real deletion has to *resolve* each one instead — reassign authorship to the dashboard owner, or anonymise the account rather than remove the row. The decision to make first is which of those two it is, because soft-delete-then-reap and anonymise-in-place want different schemas. Blocked in practice on **#57**: an owner deleting their account today would take every dashboard they own with it, including ones other people depend on, so there has to be somewhere for ownership to go first. *(Medium)*
- **#57 — Dashboard ownership cannot be transferred (2026-07-28).** Owner is `dashboards.user_id`, and owner is modelled as the *absence* of a share ([ADR-001](adr/ADR-001-per-resource-sharing.md)), so a transfer is three coupled writes rather than one: move `user_id`, delete the new owner's `resource_shares` row, and add one for the old owner if they are to keep access. Nothing can do it today, which means **a shared household dashboard dies with whoever happened to create it** — and it is what blocks account deletion (#56) from being safe. Design decisions to settle: whether the old owner is demoted to editor or dropped entirely, whether the new owner must already be a share principal (probably yes — it avoids inviting and promoting in one unreviewable step), and what happens to `resource_shares.granted_by` rows the old owner issued (they are NOT NULL with no `ON DELETE`, so they pin the account either way). *(Medium)*
- **#58 — Losing access to a shared dashboard is silent (2026-07-28).** Every path by which a non-owner loses a dashboard tells them nothing. Trashing it stamps `deleted_at`, which `load_dashboard_access` filters, so shared users get a bare 404 the moment the owner deletes — no notification, no "the owner removed this", and their bound widgets fall back to `WidgetErrorState`'s generic "may have been deleted or removed from this dashboard". They cannot restore it either, since restore is owner-only, and after `trash_retention_days` the reaper purges the cascade — **including lists and events those users authored themselves**. Removing a share has the same shape: the row disappears and nothing is sent, even though `stage_notification` is already wired for the *added* case in the same handler. Smallest useful fix is a notification on share-removed and on trash-of-a-shared-dashboard; the larger question is whether a shared user should be warned before content they wrote is purged with someone else's dashboard. Related and cheap: an editor can act on a dashboard but cannot see **who else** has access, which may be deliberate or merely unbuilt — worth deciding rather than leaving ambiguous. *(Small-Medium)*
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
