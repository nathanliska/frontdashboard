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
| 4 | Data layer, contracts & exposure | #17, #22◐, #24 |
| 5 | Infra / CI / ops | #33, #35, #34, #20◐, #36◐ |
| 6 | UX & cleanup | #27, #40, #42◐, #54 |
| — | Backlog (unscheduled) | #14◐, #16, #18, #19◐, #25, #26, #39, #52, #21/#45 (deferred) |

◐ = partially done; the line below states the remaining scope.

## Phase 4 — Data layer, contracts & exposure

- **#17 — Replace the agenda's client-side 1+N request fan-out.** Agenda loads list summaries then one detail request per active list, so the request count grows with every list on the dashboard. Add a dashboard-scoped agenda endpoint (or batch list-detail), cached by dashboard + window. *(Medium)*
- **#22◐ — Notification list growth.** Done: capped page no longer overwrites the authoritative unread total; duplicate SSE ids ignored; read-decrement fixed. Remaining: a cursor for notifications/activity so the list stays bounded as history accumulates. *(Small-Medium)*
- **#24◐ — Request-cache consolidation (premise corrected 2026-07-25).** The original finding read four in-flight implementations as one thing implemented four ways. Reading them, that isn't true, and the "adopt TanStack Query, delete ~330 lines" plan would have deleted the working code and kept the messy code. What each actually is: `api/client.ts`'s `refreshPromise` is a **token-refresh mutex, not a cache** — no query library replaces it, it stays. `resources/scopedQuery.ts` (234 lines, tested, serving five queries) is a competent keyed cache with in-flight dedup, staleness and subscriptions — it is the thing a library would replace, i.e. the wrong target. The dashboard store's coalescing **is not duplication either**: `loadDashboard` merges `background`/`surfaceAccessLoss` across a queued follow-up so a real navigation upgrades an in-flight background refetch and still evicts on 403 — `scopedQuery.fetch` discards new options when a request is already running, so moving it there would either lose that or push supersession into the primitive the other five queries use cleanly. Done: deleted the genuinely redundant single-flight `Map` for dashboard detail (its only caller coalesces above it); the share-read `Map` stays, documented — the settings modal fetches from an effect with no coalescing above it and StrictMode double-invokes it. Remaining, and the only real gap: **`scopedQuery` entries are never evicted**, so a long-lived tab scrolling the calendar accumulates one entry per window until logout. Bounded and small — fix it with a TTL sweep when it justifies the timer, not before. Revisit the library question only if #22's cursor becomes real pagination, which is the shape that would earn it. *(Small)*

## Phase 5 — Infra / CI / ops

- **#33 — Move migrations out of application startup.** Every API container runs `alembic upgrade head` before serving, so a restart mid-deploy races itself. Run one explicit migration step under an advisory lock, gated on a verified backup. *(Medium)*
- **#35 — Define & test backup/restore.** No backup, no retention, no restore test — against irreversible, data-deleting migrations. Automate a pre-migration dump, keep copies off-host, and **actually restore one** to prove it works. The most valuable item in this file. *(Medium)*
- **#34 — Deploy a matched pair of images.** Both images default to mutable `latest`, so a partial push can leave a new frontend talking to an old backend — the one runtime failure the contract gate can't catch ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). Tag by release/SHA and deploy the pair together, with a documented rollback to the previous tag. *(Small-Medium)*
- **#20◐ — Test against Alembic's deployed schema.** Done: shared fixture upgrades through the full chain, a test runs `alembic check` + heads check, `create_all` gone, notification FK reconciled. Remaining: an upgrade test from a prior data snapshot — pairs naturally with #35's dumps. *(Small)*
- **#36◐ — Reproducible production containers.** Done: frontend build on Node 22 (matches CI), root `.dockerignore` allowlist, multi-stage backend image (uv and its wheel cache no longer ship), `uvicorn[standard]` replaced by explicit `uvloop`/`httptools` so PyYAML, websockets and watchfiles no longer ship (verified absent in the built image; uvloop and `HttpToolsProtocol` verified as the selected implementations, and watchfiles moved to the dev group because `--reload` needs it), all four base images pinned by digest, and the backend image runs as uid 10001 with a CI step asserting it. Pinning by digest freezes base-image security patches, so a `docker` Dependabot ecosystem was added in the same change — without it the pin is a liability, not a hardening. Remaining: **the frontend image still runs as root**, because Caddy binds `:80` there; moving it to an unprivileged port has to be coordinated with whatever fronts it (Cloudflare tunnel), so it needs a deployment decision rather than a code change. *(Small)*

## Phase 6 — UX & cleanup

- **#27 — Accessible dialog / popover / feedback / action primitives.** Dialogs duplicate incomplete focus trapping/labelling; popovers lack `aria-expanded`/Escape; Confirm always says "Delete"; toasts/errors aren't announced; card actions are hover-only. Adopt Radix UI for Dialog/Popover (decided 2026-07-11), parameterize label/tone, add live regions + field-linked errors, replace hover-only actions with a visible overflow menu (≥44px targets). *(Medium)*
- **#40 — Simplify archive/delete into a recoverable lifecycle.** Lists need two-step archive-then-delete; dashboards expose archive + immediate permanent delete; row/card actions are hidden. Move to one "Move to trash" action with a trash view, restore, and the decided 30-day retention purge; align dashboard/list behavior; explain dependent widgets first. *(Medium)*
- **#42◐ — Small correctness traps.** Done: docs rewritten, persistence writes only `sidebarCollapsed`, concurrent-confirm + unmount/boundary resolution, dead audience plumbing removed. Remaining: replace raw bearer-URL dev logging while keeping a usable local token flow. *(Small)*
- **#54◐ — Consolidate the test suite (frontend done).** `src/test/` now holds shared entity fixtures (`makeDashboard`, `makeDashboardSummary`, `makeListSummary`, `makeListItem`, `makeListDetail`), `stubDashboardStore()` for the 23-line inert-store block that was duplicated in five files, `sortableListMock` for the dnd-kit stand-in two reorder tests carried verbatim, and `toastMock()` for the surface eight files each re-declared. The three reorder files are table-driven where the cases genuinely mirror (`ListsLayout` 206→116, `ListDetailPage` 160→71, `listData.reorder` 572→400). Frontend test lines 6,594→6,016 with the test count unchanged, so nothing stopped being covered. **Two things worth keeping in mind before "finishing" this:** not every local fixture was duplication — `agendaData`'s item default carries `due_date` because an agenda entry only exists when an item is due, and `listData`/`ListWidget` assert `"Groceries"`/`"Buy milk"` back out of rendered output. Those keep file-local defaults layered over the shared base, which is the pattern to follow rather than flatten. Likewise the reorder halves were only ~5/16 genuinely mirrored; self-echo, duplicate-id and in-flight-fetch cases are items-only and archived-subset handling is lists-only. Remaining: backend fixtures (`tests/helpers.py` is already shared, so this is smaller than the frontend was). *(Small)*

## Backlog (unscheduled)

- **#14◐ — Boundary input validation.** Done: reorder DTOs, display-name bounds, dashboard name/mutation-id bounds, forbid-unknown on create/profile/preference. Remaining: type `layout` and `WidgetCreate.config` server-side — both are still `dict[str, Any]`, which is why the client hand-authors a layout item schema instead of generating one ([ADR-018](adr/ADR-018-generated-validated-contracts.md)). *(Small-Medium)*
- **#16 — Make calendar work proportional to the requested window.** A window request loads every active event for every accessible dashboard, expands recurrence in Python, and sorts globally; monthly/yearly rules iterate from series start. The cheap half — split recurring/non-recurring SQL, index it, persist recurrence bounds, window-filter overrides — is worth doing when the calendar is actually slow. *(Medium)*
- **#18 — One typed path for access resolution.** Access is resolved through ~35 `resource_type` branches spread across `services/shares.py`, which is where the N+1s (#25) and the race fixes (#19) keep landing. **The polymorphic share table stays** — per-resource sharing is a kept capability ([ADR-001](adr/ADR-001-per-resource-sharing.md), decided 2026-07-11), so this is consolidation, not removal: one typed policy entry point that owner/viewer/editor and dashboard/child resolution all go through, leaving the schema alone. *(Medium)*
- **#19◐ — Validate share targets, atomic upserts.** Done: reject self / nonexistent / deleted / unverified targets; duplicate initial targets rejected at the schema. Remaining: replace read-before-insert with `INSERT … ON CONFLICT`, add user/dashboard FKs (via #18). *(Small)*
- **#25 — Remove avoidable access/query N+1s.** Dashboard access invokes irrelevant inherited-resource discovery; per-notification refresh; per-child share-cleanup loop. Add an owner-or-share `EXISTS` access query, one flush/RETURNING path, set-based cleanup. *(Medium)*
- **#26 — Standardize API errors + visible recovery states.** Integrity/FK races surface as generic 500s, and outages render as "No events" / zero unread instead of something the user can retry. Translate the narrow `IntegrityError`s and render explicit retryable states. *(Small-Medium)*
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
  Argon2 limiter are the ceilings that bind before process count does, and both are settings.

## Accepted risks / won't-do

- **Register enumeration — acceptance lapsed, pending re-decision under #55.** `POST /register` returns `409 "Email already registered"` for a known email. This was accepted on the premise of near-closed registration; registration is open, so the premise no longer holds and the entry stays here only to record that the behavior is unchanged while #55 decides. See [ADR-011](adr/ADR-011-enumeration-safe-login.md).
