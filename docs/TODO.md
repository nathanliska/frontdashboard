# FrontDashboard — Remediation Backlog

Open work only, from the 2026-07-11 design review and its follow-up passes. Findings keep their
original numbers so older references still resolve.

An item here states what is **still open** and the decision that has to be settled first. It does
not restate what already shipped — that is in git history, and the durable decisions are in the
[ADRs](adr/INDEX.md) / [FDRs](fdr/INDEX.md), with current behavior in [CONTEXT.md](../CONTEXT.md).
Phases 1–4 shipped.

**Scale:** a small user base, one Compose stack, one backend replica. Machinery that only
pays off at fleet scale stays deferred — prefer the fix that deletes lines. Scale is by replica, not
by uvicorn worker; shared state (rate limits, SSE fan-out) is already on Valkey, so what a second
replica still needs is routing. The ceilings that bind first are the DB pool and the Argon2 limiter,
both config.

**Exposure:** public internet, registration open to anyone with a verifiable email. Abuse,
enumeration and data-privacy findings get no small-deployment discount.

**Maintenance:** when an item ships, delete it here; if it set a cross-cutting decision, write or
update an ADR/FDR in the same change. New work appends with the next free number. Keep an entry to
a few sentences — if it needs more, the reasoning belongs in an ADR/FDR and the entry links to it.

## Phases

| Phase | Theme | Open findings |
|------:|-------|---------------|
| 5 | Infra / CI / ops | #33◐, #35◐, #20◐, #66 |
| — | Backlog (unscheduled) | #16◐, #39, #56, #57, #58◐, #59, #60, #63, #64, #65◐, #21/#45 |

◐ = partially done; the entry states the remaining scope.

## Phase 5 — Infra / CI / ops

- **#33◐ — Move migrations out of application startup.** Concurrent `alembic upgrade head` runs now
  serialize on an advisory lock in `alembic/env.py`. Remaining: making migration a deliberate deploy
  step gated on a verified backup, which is #35's dependency and deferred with it. Startup migration
  is fine at one replica. *(Small, coupled to #35)*
- **#35◐ — Verify backup/restore.** Backups exist and the rehearsal harness has landed
  ([database-restore.md](runbooks/database-restore.md)). Both gaps are operational rather than code,
  and need the box rather than this repo: an **off-host destination** (a copy on the machine that
  died is not a backup), and running the rehearsal against a **real production dump** — everything so
  far was proven against synthetic ones. *(Small — harness done)*
- **#66 — The only external availability alert cannot fire.** `SiteDown` and
  `CertificateExpiringSoon` both name `probe_success{job="blackbox-public"}` and no
  `blackbox_exporter` is installed, so both stay silent forever — every other target is inside the
  Docker network, so the board reads green while Caddy or Cloudflare is what broke. Unlike the
  exporters deferred below, nothing self-instrumented can substitute: an unreachable app cannot
  report that it is unreachable. `PublicProbeMissing` is the canary and fires 10m after import. Fix
  is an install plus the job in [observability/README.md](../observability/README.md). *(Small — one
  install on the box)*
- **#20◐ — Test against Alembic's deployed schema.** Done bar one piece: an upgrade test from a
  prior data snapshot, which pairs naturally with #35's dumps. *(Small)*

## Backlog (unscheduled)

- **#21 / #45 — Replica readiness; routing is what remains.** The shared state is done — rate-limit
  buckets and the SSE backplane are both on Valkey ([ADR-004](adr/ADR-004-sse-over-websocket.md),
  [ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md)), and the invariants that kept that a swap
  rather than a rewrite are recorded there. **Open gap:** `Caddyfile.prod` names a static
  `frontdashboard-backend:8000`, so a second replica takes no traffic. It needs a dynamic A-record
  upstream with `lb_policy`, plus `container_name` dropped. Notes for whoever does it: `dynamic a`
  needs an explicit `resolvers 127.0.0.11` for Docker's embedded DNS; active health checks do **not**
  run against a dynamic upstream, so `health_uri` is inert there and passive `fail_duration` is what
  applies, with a new replica waiting up to the 1m default `refresh` for traffic. The scaling lever
  in the host's compose UI is `deploy.replicas`, not `--scale` (that UI offers no place to pass a
  flag); measured on the version deployed there, `--scale` exits 1 having started nothing.
  **Postgres is the ceiling:** each replica opens its own pool, so 10N against a default
  `max_connections` of 100 caps this near 8 replicas — anything automatic wants PgBouncer first.
  Not scheduled; the trigger is the first replica rather than a date. *(Medium)*
- **#39 — Extract use cases from the dashboard router.** ~1,200 lines coupling validation, authz,
  persistence, activity, notification and SSE, repeating the same transaction/broadcast dance per
  handler. Worth doing as the deletion it implies — one unit of work plus a staged outbox, routers as
  thin adapters — not as a speculative layer. *(Large)*
- **#56 — Account deletion is wanted and unbuilt, and the schema pretends otherwise.**
  `User.deleted_at` is filtered in 8 places across 4 modules but **nothing sets it**. Every `NOT
  NULL` FK to `users.id` blocks the row and none carry `ON DELETE`, so deletion has to *resolve*
  each — the decision to settle first is reassign-authorship versus anonymise-in-place, because they
  want different schemas. Blocked in practice on #57: an owner leaving today would take every
  dashboard they own with them. *(Medium)*
- **#57 — Dashboard ownership cannot be transferred.** Owner is modelled as the *absence* of a share
  ([ADR-001](adr/ADR-001-per-resource-sharing.md)), so a transfer is three coupled writes rather than
  one. Nothing can do it today, so **a shared household dashboard dies with whoever created it**, and
  it is what blocks #56 from being safe. To settle: whether the old owner is demoted or dropped,
  whether the new owner must already be a share principal (probably yes — it avoids inviting and
  promoting in one unreviewable step), and what happens to `granted_by` rows they issued. *(Medium)*
- **#58◐ — Losing access to a shared dashboard.** Both silent paths now notify
  ([FDR-007](fdr/FDR-007-notifications-and-activity.md) §5). Remaining are product questions rather
  than missing code: whether a shared user is warned **again before the purge**, since the reaper
  later takes the cascade including lists and events they authored themselves, and whether they get
  any route back at all — restore is owner-only. Related and cheap: an editor cannot see who else has
  access, which may be deliberate or merely unbuilt. *(Small, product decisions first)*
- **#59 — Changing an email address is unbuilt.** An address entered at signup is permanent, and the
  case-insensitive unique index reserves it forever with no account deletion (#56) to release it.
  Constraints: the new address must be verified **before** the switch or a typo locks the account out
  permanently; the old address should be notified, since that is how a takeover is detected; and it
  needs a pending-change record distinct from `email_verification_tokens`. The trap: an obvious
  "already in use" response **reintroduces the enumeration oracle**
  ([ADR-011](adr/ADR-011-enumeration-safe-login.md)) — it has to say "check your new address" and
  silently do nothing when taken. *(Medium)*
- **#60 — No session-management UI, and the columns for one sit empty.** `sessions` has
  `device_name`, `ip_hash` and `user_agent_hash` and nothing writes them — deliberate, since with no
  screen to read them it would mean collecting client IPs for nobody. It matters because dropping
  refresh-token rotation ([ADR-003](adr/ADR-003-first-class-sessions.md)) removed the only mechanism
  that would have signalled a **copied session cookie**. The machinery exists (`revoke_session` is
  the single choke point), so this is two endpoints and a panel. To settle first: `ip_hash` needs a
  **keyed** hash, since a plain SHA-256 of an IPv4 is brute-forceable in seconds and so anonymises
  nothing; and `device_name` has no trustworthy source. *(Small-Medium)*
- **#63 — `test_the_liveness_predicate_is_shared` failed once, unreproduced.** `resolve_session`
  treated a session as expired while `session_is_live` still called it live, at the
  `session_idle_days + 1s` boundary. Did not recur across ten runs; both paths take their own
  `datetime.now(UTC)` so clock skew was ruled out, and the mechanism is unknown. A fixed clock
  injected into `_live` would make the question unaskable. *(Small, Low severity)*
- **#64 — Move the rate limiter off its synchronous Redis client.** slowapi's storage is a
  synchronous client called per rate-limited request, so with the store unreachable the connect cost is
  paid on the event loop rather than beside it
  ([ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md) records the measurement). No configuration
  reaches it and `asyncio.wait_for` cannot either, a timeout callback being unable to fire on a
  frozen loop. The fix is dropping slowapi for `limits.aio`, which also costs the `@limiter.limit`
  decorator and the coverage test that enforces it — so it wants a trigger: the store restarting often
  enough to notice, or a second replica. *(Medium, no trigger yet)*
- **#65◐ — Occurrence expansion is bounded per event and per dashboard, not per request.** Every
  per-event axis is capped, and `quota_events_per_dashboard` now bounds how many events one
  dashboard can hold ([ADR-020](adr/ADR-020-resource-quotas.md)). Remaining: the query still has no
  `LIMIT`, so a request spanning many accessible dashboards multiplies that ceiling by their number.
  Worth measuring before building: `frontdashboard_http_request_seconds` on `/api/calendar/events`
  is where it would first show. *(Small, no trigger yet)*
- **#16◐ — Make calendar work proportional to the requested window.** The router no longer loads
  every event on every accessible dashboard. Remaining, and only worth it if a calendar is ever
  actually slow: series with a `count` limit and no `until` still load unbounded, since finding their
  end means expanding the rule — which is the work being avoided. A persisted last-occurrence column
  was considered and rejected ([FDR-006](fdr/FDR-006-calendar-and-events.md)). *(Small, no trigger)*

## Deferred — revisit when

Capabilities deliberately not built. Each states the condition that would make it worth the weight.

- **Conflict-free list reorders** — when a concurrent drag is ever actually lost and missed. Two
  members reordering the same list at the same moment each send the full new ordering, and the
  later write silently replaces the earlier one; the loser sees the true order a moment later over
  SSE and a re-drag costs seconds. The fix to build is fractional indexing: each item carries its
  own position key, a drag writes one row, and concurrent drags of different items merge instead of
  colliding — not a layout-style version column, whose 409 would punish the common non-conflicting
  case. Accepted as last-write-wins at household scale.
- **Paginating the dashboard and list trashes** — when a trash response is ever observed at a
  size that matters. The event trash pages by cursor because its quota is 10,000 per dashboard;
  the other two return complete listings (quota-bounded at 100 dashboards, 200 lists/dashboard,
  and the 30-day reaper trims both). The list trash spans all accessible dashboards, so its real
  bound is consent — which "leave dashboard" makes withdrawable. The envelope-plus-cursor pattern
  to copy is the event trash ([FDR-006](fdr/FDR-006-calendar-and-events.md)).
- **Tracing and structured logging** — when a problem survives a session of reading logs by hand.
  Counters shipped because scaling decisions were being made from reasoning rather than measurement;
  per-request tracing is a different weight and answers no question being asked.
- **Exporters for infrastructure we don't own** (`redis_exporter`, `postgres_exporter`) — when a
  reading we already have prompts a question about the service underneath it. The split decides where
  every future metric goes: an app instruments *itself*, an exporter translates software you cannot
  modify. Deliberately not now — Valkey holds rate-limit counters and a `MAXLEN`-capped stream, both
  self-expiring, and `noeviction` means a full store reaches the app as a failed write that
  `rate_limit_store_degraded` already reports. Measured 2026-08-07: `used_memory` 1.35 MiB against
  the 64 MiB cap. A `redis_exporter` was built and reverted the same day rather than re-argued.
- **SSE replay of event bodies from the activity log** — gap *detection* shipped
  ([FDR-008](fdr/FDR-008-realtime-sse.md) §5); replaying bodies only pays off when events actually
  occurred. Three constraints detection never had to meet: the audience must be recomputed at replay
  time, so a share revoked while disconnected cannot become replayable; no index fits the query, so
  the replay must be bounded and fall back to resync; and `event_id` is assigned at flush, so it
  orders assignments rather than commits and wants a commit-ordered stream id first.
- **Distinct counts of people or devices holding streams** — set cardinality is per-process and does
  not sum, so this needs the backplane to know the global set. Gauges were tried and removed
  (2026-08-04) rather than ship reading as a floor; worth building alongside, not before.
- **Off-dashboard sharing (direct list/event shares)** — when someone actually asks to hand a single
  list or event to a user without the whole dashboard. The scaffolding already exists and should not
  be "simplified" away meanwhile: `ResourceType` carries `list`/`calendar_event`, the child `/shares`
  endpoints are deliberate 409 stubs ([FDR-004](fdr/FDR-004-sharing-and-access.md)),
  `resource_shares` is one dropped CHECK + FK away from polymorphic
  ([ADR-001](adr/ADR-001-per-resource-sharing.md)), and the four capability predicates plus the
  server-derived `can_*` booleans on dashboard summaries are the seams it lands in.
- **SBOM + release signing** — when there are external contributors, redistribution, or a compliance
  ask.
- **Dependency/SAST/secret/image scanning in CI** — when the app stores anything beyond calendars,
  lists and dashboards, or when contributors outnumber one. Dependabot + `osv-scanner` cover the
  realistic case now.
- **Browser/a11y regression tests (Playwright + axe)** — the primitives exist and each is unit-tested
  for its accessible wiring; what is missing is *cross-component* coverage in a real browser — focus
  order across a page, keyboard traversal, contrast. Worth it when a regression slips through the
  unit tests, or when the component set outgrows a by-hand recheck.
- **Container hardening beyond non-root + digest pinning** (read-only fs, tmpfs, dropped caps,
  `no-new-privileges`, resource/PID limits) — when the origin is reachable outside the Cloudflare
  Tunnel, or when it runs untrusted workloads.
- **Dropping runtime response validation** — the generated types are free; the runtime half is
  ~14.5 kB gzip. Revisit if bundle size ever outweighs the guarantee — generating types without a
  runtime is a one-flag change ([ADR-018](adr/ADR-018-generated-validated-contracts.md)).
- **Image provenance/SBOM attestations** — when the images gain a consumer that verifies them.
  The publish job's matched-pair choreography (build with `load:`, push tags by hand so `:latest`
  can never point at a split pair) cannot carry attestations; adopting them means reworking that
  ordering, and today the only puller is the prod host, by hand, verifying nothing.
- **Runner hardening beyond the zizmor gate** — pinning `ubuntu-latest` to a release trades
  surprise label migrations for permanent manual bumps, and egress allowlisting
  (StepSecurity harden-runner) is defense-in-depth at real weight. Revisit when the repo gains a
  second maintainer or the workflows start handling secrets beyond `GITHUB_TOKEN`.

## Accepted risks / won't-do

- *(none open — register enumeration was closed by #55 rather than accepted; registration now
  answers identically for known and unknown addresses. See
  [ADR-011](adr/ADR-011-enumeration-safe-login.md).)*
