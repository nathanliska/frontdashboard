# FrontDashboard — Remediation Backlog

The live backlog of **open** work, distilled from the 2026-07-11 design review and its follow-up
passes. Findings keep their original numbers so older references still resolve.

Closed findings are **not** listed here — their execution detail is in git history, and the durable
decisions they established are captured in the [ADRs](adr/INDEX.md) / [FDRs](fdr/INDEX.md). Phases
1–3 (security quick wins, auth/session hardening, dashboard correctness) all shipped; see
[CONTEXT.md](../CONTEXT.md) for current behavior.

**Maintenance:** when an item ships, delete it here; if it set a cross-cutting decision, write/update
an ADR (or the relevant FDR) in the same change. New work appends with the next free number. Severity
and effort are noted inline where known.

## Phases

| Phase | Theme | Open findings |
|------:|-------|---------------|
| 4 | Data layer & contracts | #16, #17, #22◐, #23, #24 |
| 5 | Infra / CI / ops | #20◐, #32◐, #33, #34, #35, #36◐, #37◐ |
| 6 | UX & cleanup | #27, #40, #41◐, #42◐ |
| — | Backlog (unscheduled) | #14◐, #18, #19◐, #21, #25, #26, #28◐, #29, #30◐, #38◐, #39, #45 (deferred), #52, #53 |

◐ = partially done; the line below states the remaining scope.

## Phase 4 — Data layer & contracts

- **#16 — Make calendar work proportional to the requested window.** A window request loads every active event for every accessible dashboard, expands recurrence in Python, and sorts globally; monthly/yearly rules iterate from series start. Split recurring/non-recurring SQL, add indexes + persisted recurrence bounds, window-filter overrides, consider an RFC 5545 library. *(Large)*
- **#17 — Replace the agenda's client-side 1+N request fan-out.** Agenda loads list summaries then one detail request per active list. Add a dashboard-scoped agenda/reminder endpoint (or batch list-detail), cached by dashboard + window. *(Medium-Large)*
- **#22◐ — Notification counts / dedup / pagination.** Done: capped page no longer overwrites the authoritative unread total; duplicate SSE ids ignored; read-decrement fixed. Remaining: cursor envelopes / load-more for notifications and activity, and durable dedup across reconnects when an id isn't retained client-side. *(Medium)*
- **#23 — Generate & validate frontend API/event contracts.** `res.json() as ...` casts, hand-duplicated DTOs, `Record<string, unknown>` widget config, stringly-typed SSE names. Generate types from OpenAPI, validate at network boundaries, model widgets/SSE as discriminated unions, fail CI on client drift. *(Medium-Large)*
- **#24 — Consolidate server state on a lifecycle-aware query layer.** The custom scoped-query caches never evict until logout and lack stale/gc/cancel/retry/focus-refresh; window navigation accumulates map entries. Either migrate to TanStack Query or implement those lifecycle guarantees explicitly. Keep Zustand for UI state. *(Large)*

## Phase 5 — Infra / CI / ops

- **#20◐ — Test against Alembic's deployed schema.** Done: shared fixture upgrades through the full chain, a test runs `alembic check` + heads check, `create_all` gone, notification FK reconciled. Remaining: an upgrade test from a supported prior data snapshot. *(Medium)*
- **#32◐ — Expand CI gates.** Done: migrated-schema tests, deptry, actionlint, knip, run cancellation, prod frontend image build. Remaining: prior-version upgrade test, contract/coverage gates, browser/a11y (Playwright + axe), backend-prod-image/Compose validation, dependency/SAST/secret/image scanning, SBOMs, release signing. *(Medium-Large)*
- **#33 — Move migrations out of application startup.** Every API container runs `alembic upgrade head` before serving. Run an explicit one-shot migration stage under an advisory lock with preflight + backup gate; adopt expand/migrate/contract. *(Medium)*
- **#34 — Publish atomic, immutable releases.** Two images default to mutable `latest`; a partial push can deploy mismatched front/back. Build both in CI, tag by release/SHA + digest, deploy one pinned manifest after checks, add smoke checks + rollback. *(Medium)*
- **#35 — Define & test backup/restore for self-hosters.** No backup/retention/restore-test/preflight despite irreversible, data-deleting migrations. Automate pre-migration backups, encrypted off-host retention, restore drills; gate destructive migrations on a verified backup. *(Medium)*
- **#36◐ — Harden & reproduce production containers.** Done: frontend build on Node 22 (matches CI), root `.dockerignore` allowlist. Remaining: pin base/tool images by digest, run non-root, apply/test read-only fs, tmpfs, dropped caps, `no-new-privileges`, resource/PID limits. *(Medium)*
- **#37◐ — Readiness, DB lifecycle, observability.** Done: pooled-connection pre-ping + engine disposal on shutdown. Remaining: split `/health/live` and bounded `/health/ready`, size/time-bound the pool + statements, add request ids, structured logging, metrics, slow-query visibility. *(Medium)*

## Phase 6 — UX & cleanup

- **#27 — Accessible dialog / popover / feedback / action primitives.** Dialogs duplicate incomplete focus trapping/labelling; popovers lack `aria-expanded`/Escape; Confirm always says "Delete"; toasts/errors aren't announced; card actions are hover-only. Adopt one tested Dialog/Popover primitive, parameterize label/tone, add live regions + field-linked errors, replace hover-only actions with a visible overflow menu (≥44px targets). *(Medium)*
- **#40 — Simplify archive/delete into a recoverable lifecycle.** Lists need two-step archive-then-delete; dashboards expose archive + immediate permanent delete; row/card actions are hidden. Move to one "Move to trash" action with a trash view, restore, and retention-based purge; align dashboard/list behavior; explain dependent widgets first. *(Medium)*
- **#41◐ — Split routes / remove dead surfaces.** Done: route-level lazy loading (main chunk 526→310 kB), knip CI gate, dead components/`App.css` removed, vestigial `membership.*` event variants removed (backend `EventType` + frontend notification-feed cases). Remaining: remove the dead `CalendarReminder` schema (or complete it explicitly). *(Small)*
- **#42◐ — Transient state & small correctness traps.** Done: docs rewritten, persistence writes only `sidebarCollapsed`, concurrent-confirm + unmount/boundary resolution, dead audience plumbing removed. Remaining: replace raw bearer-URL dev logging while keeping a usable local token flow. *(Small)*

## Backlog (unscheduled)

- **#14◐ — Boundary input validation.** Done: reorder DTOs, display-name bounds, dashboard name/mutation-id bounds, forbid-unknown on create/profile/preference. Remaining: typed layout/widget-config models, stronger field typing, request-body size bound. *(Medium)*
- **#18 — Commit to one visibility model, schema-enforce it.** A polymorphic share table + hundreds of lines still model direct list/event shares though runtime visibility is dashboard-owned. Either replace with `dashboard_shares(dashboard_id, user_id, role)` + cascading FKs and remove child-share code, or build a single typed policy engine. Depends on the sharing decision in [ADR-001](adr/ADR-001-per-resource-sharing.md). *(Large)*
- **#19◐ — Validate share targets, atomic upserts.** Done: reject self / nonexistent / deleted / unverified targets; duplicate initial targets rejected at the schema. Remaining: replace read-before-insert with `INSERT … ON CONFLICT`, add user/dashboard FKs (via #18). *(Medium)*
- **#21 — Durable, multi-process SSE delivery.** The manager singleton only reaches clients in the mutating process; a crash after commit loses delivery, workers split streams, reconnect ignores a persisted cursor. Transactional outbox + Redis/Postgres pub/sub, durable event ids, replay after `Last-Event-ID`. Overlaps #45. *(Large)*
- **#25 — Remove avoidable access/query N+1s.** Dashboard access invokes irrelevant inherited-resource discovery; per-notification refresh; per-child share-cleanup loop. Add an owner-or-share `EXISTS` access query, one flush/RETURNING path, set-based cleanup; add query-count tests. *(Medium)*
- **#26 — Standardize API errors + visible recovery states.** Integrity/FK races become generic 500s; outages render as "No events" / zero unread; no correlation id. Translate narrow `IntegrityError`s, emit RFC 7807 codes + request ids, centralize typed client parsing, render explicit retryable error states. *(Medium)*
- **#28◐ — User-discovery privacy & search performance.** Done: exclude deleted/unverified, ≥2-char floor, escape LIKE wildcards. Remaining: decide/mask full-email visibility, rate-limit discovery, choose prefix vs substring semantics + matching index. *(Small-Medium)*
- **#29 — Indexes & uniqueness for real dashboard/widget paths.** `dashboards.user_id` is unindexed since the one-per-user index was dropped; widget reverse lookups aren't indexed; resource-widget uniqueness relies on read-before-insert. Add `(user_id, archived, updated_at)`, `(resource_type, resource_id, dashboard_id)`, and a partial unique constraint. *(Small)*
- **#30◐ — Remaining domain invariants in Postgres.** Done: nonnegative `sort_order` CHECKs (also closed #14's `ge=0`). Remaining: widget-resource paired-field constraints, reminder-offset (dead schema — see #41), assignee-in-audience validation, calendar-override occurrence-membership. *(Medium)*
- **#38◐ — Bound collection APIs & retained rows.** Done: scheduled advisory-locked reaper prunes expired tokens + idle sessions. Remaining (the *should-grow* half): collection pagination (dashboards/lists), a notification cursor, an `activity_events` retention horizon — bound, don't prune. *(Medium)*
- **#39 — Extract use cases from oversized routers.** The 1,092-line dashboard router couples validation/authz/persistence/activity/notification/SSE and repeats transaction/broadcast patterns. Extract narrow use cases with a unit of work + staged outbox; keep routers as adapters. *(Large)*
- **#45 — Horizontal-scaling / multi-process readiness (deferred).** Auth authority is already cluster-safe (sessions in Postgres, worker-agnostic revocation). Not yet: process-local SSE fan-out (needs a pub/sub backplane — the real blocker), per-process rate-limit buckets (shared store), startup-migration races (#33), pool multiplication (PgBouncer). No scaling need at household scale; recorded so the pieces are known. *(Large)*
- **#52 — SSE overflow eviction is attacker-inducible (Low).** A co-member (editor/viewer) driving >256 rapid mutations can pin a victim in a reconnect/resync/refetch loop (UX collapse + GET amplification). Not a silent deafen. Rate-limit per-client evictions, coalesce/drop-oldest with a single resync, cap resyncs/min/connection. *(Medium — needs a small backpressure design)*
- **#53 — Tablet-band (640–959px) drag can persist a 6-col layout over the canonical 12-col.** Logged 2026-07-20 in the Phase 3 whole-branch review; pre-existing, not a slice regression. The per-breakpoint-layout follow-up noted in the layout-save work — see [ADR-009](adr/ADR-009-canonical-layout-mobile-projection.md).

## Accepted risks / won't-do

- **Register enumeration.** `POST /register` returns `409 "Email already registered"` for a known email. Accepted at household scale (near-closed registration; the privacy-preserving alternative degrades signup UX). **Revisit if registration ever opens to the public.** See [ADR-011](adr/ADR-011-enumeration-safe-login.md).
