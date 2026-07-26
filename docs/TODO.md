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
pool and the Argon2 limiter, both config — see #37.)

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
| 4 | Data layer, contracts & exposure | #55, #17, #22◐, #24 |
| 5 | Infra / CI / ops | #33, #35, #34, #20◐, #32◐, #36◐, #37◐ |
| 6 | UX & cleanup | #27, #40, #42◐, #54 |
| — | Backlog (unscheduled) | #14◐, #16, #18, #19◐, #25, #26, #29, #30◐, #38◐, #39, #52, #56, #53, #21/#45 (deferred) |

◐ = partially done; the line below states the remaining scope.

## Phase 4 — Data layer, contracts & exposure

- **#55 — Re-decide register enumeration under open registration.** [ADR-011](adr/ADR-011-enumeration-safe-login.md) accepts a `409 "Email already registered"` on duplicate signup *because* registration was near-closed, and closes with "revisit if registration ever opens to the public". It is open, so that acceptance has expired on its own terms — the 409 lets anyone test whether an address has an account. Mitigating factor: login requires a verified email, so probing costs the attacker a real mailbox per hit. Decide deliberately (accept with corrected reasoning, or move to a verify-by-email signup that reveals nothing) and supersede or amend the ADR either way. *(Small)*
- **#17 — Replace the agenda's client-side 1+N request fan-out.** Agenda loads list summaries then one detail request per active list, so the request count grows with every list on the dashboard. Add a dashboard-scoped agenda endpoint (or batch list-detail), cached by dashboard + window. *(Medium)*
- **#22◐ — Notification list growth.** Done: capped page no longer overwrites the authoritative unread total; duplicate SSE ids ignored; read-decrement fixed. Remaining: a cursor for notifications/activity so the list stays bounded as history accumulates. *(Small-Medium)*
- **#24 — Collapse the four hand-rolled request caches into one.** In-flight coalescing is implemented four times in four styles: `resources/scopedQuery.ts` (234 lines), the dashboard store's serial counter plus a hand-rolled debounce that holds its own resolve/reject across five module-level mutables, the single-flight `Map`s in `api/dashboards.ts`, and the 401-refresh single-flight in `api/client.ts`. None evict before logout; none support stale/gc/cancel/retry. **This is a deletion**: one library (TanStack Query, ~13 kB gzip) or one internal primitive should remove ~330 lines of bespoke machinery and the class of bug it keeps producing. Keep Zustand for UI state. *(Large)*

## Phase 5 — Infra / CI / ops

- **#33 — Move migrations out of application startup.** Every API container runs `alembic upgrade head` before serving, so a restart mid-deploy races itself. Run one explicit migration step under an advisory lock, gated on a verified backup. *(Medium)*
- **#35 — Define & test backup/restore.** No backup, no retention, no restore test — against irreversible, data-deleting migrations. Automate a pre-migration dump, keep copies off-host, and **actually restore one** to prove it works. The most valuable item in this file. *(Medium)*
- **#34 — Deploy a matched pair of images.** Both images default to mutable `latest`, so a partial push can leave a new frontend talking to an old backend — the one runtime failure the contract gate can't catch ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). Tag by release/SHA and deploy the pair together, with a documented rollback to the previous tag. *(Small-Medium)*
- **#20◐ — Test against Alembic's deployed schema.** Done: shared fixture upgrades through the full chain, a test runs `alembic check` + heads check, `create_all` gone, notification FK reconciled. Remaining: an upgrade test from a prior data snapshot — pairs naturally with #35's dumps. *(Small)*
- **#32◐ — CI gates.** Done: migrated-schema tests, deptry, actionlint, knip, run cancellation, prod frontend image build, contract-drift job, and a frontend type check that actually type-checks (`tsc --build`; the old `--noEmit` invocation against the solution-style root config silently checked nothing). Remaining: fold the `contract` job into the existing backend or frontend job — it currently starts a third runner and installs both toolchains to regenerate one file — and validate the prod Compose file. (The backend prod image now builds in the existing backend job.) *(Small)*
- **#36◐ — Reproducible production containers.** Done: frontend build on Node 22 (matches CI), root `.dockerignore` allowlist, multi-stage backend image (uv and its wheel cache no longer ship — roughly a third off the image). Remaining: swap `uvicorn[standard]` for explicit `uvloop`/`httptools` (PyYAML, watchfiles and websockets are ~5 MB of code this app never runs — it is SSE-only per [ADR-004](adr/ADR-004-sse-over-websocket.md)), and pin base images by digest and run as non-root — the two that matter for an internet-facing origin. *(Small)*
- **#37◐ — Readiness & DB lifecycle.** Done: pooled-connection pre-ping + engine disposal on shutdown. Remaining: split `/health/live` from a bounded `/health/ready` so a DB outage stops reporting healthy, and bound the pool + statement timeouts. *(Small-Medium)*

## Phase 6 — UX & cleanup

- **#27 — Accessible dialog / popover / feedback / action primitives.** Dialogs duplicate incomplete focus trapping/labelling; popovers lack `aria-expanded`/Escape; Confirm always says "Delete"; toasts/errors aren't announced; card actions are hover-only. Adopt Radix UI for Dialog/Popover (decided 2026-07-11), parameterize label/tone, add live regions + field-linked errors, replace hover-only actions with a visible overflow menu (≥44px targets). *(Medium)*
- **#40 — Simplify archive/delete into a recoverable lifecycle.** Lists need two-step archive-then-delete; dashboards expose archive + immediate permanent delete; row/card actions are hidden. Move to one "Move to trash" action with a trash view, restore, and the decided 30-day retention purge; align dashboard/list behavior; explain dependent widgets first. *(Medium)*
- **#42◐ — Small correctness traps.** Done: docs rewritten, persistence writes only `sidebarCollapsed`, concurrent-confirm + unmount/boundary resolution, dead audience plumbing removed. Remaining: replace raw bearer-URL dev logging while keeping a usable local token flow. *(Small)*
- **#54 — Consolidate the test suite.** 6,594 frontend + 4,676 backend test lines against 12,230 + 6,394 source lines, and the excess is duplication rather than coverage: `makeListDetail`, `makeListItem` and `makeSummary` are each redefined in five files; `vi.mock('../stores/toast')` appears in five, `vi.mock('../resources/listData')` in five, `vi.mock('../api/lists')` in four. List reorder alone spans five files and ~1,414 lines — `ListsLayout.reorder.test.tsx` (206) and `ListDetailPage.reorder.test.tsx` (160) assert the same drag-handle-visibility predicate through full jsdom renders behind ~70 lines of mock scaffolding each, and the lists/items halves of `listData.reorder.test.tsx` are the same eight cases twice. Add shared fixtures + mock helpers, make mirrored cases table-driven, and assert predicates directly instead of through a rendered page — keeping every behavior currently covered. *(Medium)*

## Backlog (unscheduled)

- **#14◐ — Boundary input validation.** Done: reorder DTOs, display-name bounds, dashboard name/mutation-id bounds, forbid-unknown on create/profile/preference. Remaining: type `layout` and `WidgetCreate.config` server-side — both are still `dict[str, Any]`, which is why the client hand-authors a layout item schema instead of generating one ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). *(Small-Medium)*
- **#16 — Make calendar work proportional to the requested window.** A window request loads every active event for every accessible dashboard, expands recurrence in Python, and sorts globally; monthly/yearly rules iterate from series start. The cheap half — split recurring/non-recurring SQL, index it, persist recurrence bounds, window-filter overrides — is worth doing when the calendar is actually slow. *(Medium)*
- **#18 — One typed path for access resolution.** Access is resolved through ~35 `resource_type` branches spread across `services/shares.py`, which is where the N+1s (#25) and the race fixes (#19) keep landing. **The polymorphic share table stays** — per-resource sharing is a kept capability ([ADR-001](adr/ADR-001-per-resource-sharing.md), decided 2026-07-11), so this is consolidation, not removal: one typed policy entry point that owner/viewer/editor and dashboard/child resolution all go through, leaving the schema alone. *(Medium)*
- **#19◐ — Validate share targets, atomic upserts.** Done: reject self / nonexistent / deleted / unverified targets; duplicate initial targets rejected at the schema. Remaining: replace read-before-insert with `INSERT … ON CONFLICT`, add user/dashboard FKs (via #18). *(Small)*
- **#25 — Remove avoidable access/query N+1s.** Dashboard access invokes irrelevant inherited-resource discovery; per-notification refresh; per-child share-cleanup loop. Add an owner-or-share `EXISTS` access query, one flush/RETURNING path, set-based cleanup. *(Medium)*
- **#26 — Standardize API errors + visible recovery states.** Integrity/FK races surface as generic 500s, and outages render as "No events" / zero unread instead of something the user can retry. Translate the narrow `IntegrityError`s and render explicit retryable states. *(Small-Medium)*
- **#29 — Indexes for real dashboard/widget paths.** `dashboards.user_id` is unindexed since the one-per-user index was dropped; widget reverse lookups aren't indexed; resource-widget uniqueness relies on read-before-insert. Add `(user_id, archived, updated_at)`, `(resource_type, resource_id, dashboard_id)`, and a partial unique constraint — cheap, do it with the next migration. *(Small)*
- **#30◐ — Remaining domain invariants in Postgres.** Done: nonnegative `sort_order` CHECKs. Remaining: widget-resource paired-field constraints and calendar-override occurrence-membership. (The `minutes_before` constraint lands with the reminders feature itself — see FDR-006.) *(Small-Medium)*
- **#38◐ — Bound retained rows.** Done: scheduled advisory-locked reaper prunes expired tokens + idle sessions. Remaining: the decided ~90-day `activity_events`/notification retention horizon — that table grows forever. Collection pagination is #22's cursor. *(Small)*
- **#39 — Extract use cases from the dashboard router.** 1,139 lines coupling validation, authz, persistence, activity, notification and SSE, repeating the same transaction/broadcast dance in every handler. Worth doing as the deletion it implies — one unit of work + staged outbox, routers as thin adapters — not as a speculative layer. *(Large)*
- **#52 — SSE overflow eviction is attacker-inducible (Low).** A co-member driving >256 rapid mutations can pin a victim in a reconnect/resync/refetch loop. Stays low even under open registration: it isn't a silent deafen, and reaching a victim requires holding an invite link to a dashboard they share, so a stranger who merely signs up cannot trigger it. Coalesce evictions into a single resync and cap resyncs per connection if it ever shows up in practice. *(Medium)*
- **#56 — Direct-share API surface has no caller.** `POST /dashboards/{id}/shares` and `DashboardCreate.shares` still grant access by user id, but since #28 nothing in the client reaches them — every share is now created by redeeming an invite. The capability is deliberately kept ([ADR-001](adr/ADR-001-per-resource-sharing.md), decided 2026-07-11), so this is not a deletion; decide whether it stays as a tested-but-unused API or gets folded into the invite path, and stop generating client types for it either way. *(Small)*
- **#53 — Tablet-band (640–959px) drag can persist a 6-col layout over the canonical 12-col.** Logged 2026-07-20; pre-existing, not a slice regression. See [ADR-009](adr/ADR-009-canonical-layout-mobile-projection.md). *(Small)*
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
- **Browser/a11y regression tests (Playwright + axe)** — when #27's accessible primitives land and
  there is a component library worth pinning against regressions.
- **Container hardening beyond non-root + digest pinning** (read-only fs, tmpfs, dropped caps,
  `no-new-privileges`, resource/PID limits) — when the origin is reachable outside the Cloudflare
  Tunnel, or when it runs untrusted workloads.
- **Dropping runtime response validation** — the generated types are free; the runtime half is
  ~14.5 kB gzip of the main chunk (376 kB / 109 kB gzip, up from 311 kB). Revisit if bundle size
  ever outweighs the guarantee — generating types without a runtime is a one-flag change
  ([ADR-018](adr/ADR-018-generated-validated-contracts.md)).
- **Multi-worker / horizontal scale** — see #21/#45. Needs an SSE backplane first; the DB pool and
  Argon2 limiter (#37) are the ceilings that bind before process count does.

## Accepted risks / won't-do

- **Register enumeration — acceptance lapsed, pending re-decision under #55.** `POST /register` returns `409 "Email already registered"` for a known email. This was accepted on the premise of near-closed registration; registration is open, so the premise no longer holds and the entry stays here only to record that the behavior is unchanged while #55 decides. See [ADR-011](adr/ADR-011-enumeration-safe-login.md).
