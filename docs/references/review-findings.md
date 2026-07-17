# FrontDashboard Design Review

Reviewed 2026-07-11. This review covers the tracked FastAPI/SQLAlchemy backend, React/TypeScript frontend, PostgreSQL migrations and schema, Docker/Caddy deployment, and GitHub Actions tooling. Findings are ranked primarily by user/data/security impact divided by implementation effort; a lower-ranked large redesign can still have more absolute impact than a higher-ranked small fix.

## Rollout status

Remediation runs **security-first, one theme per phase**; each phase gets its own spec + plan in
`docs/designs/`.

**Update protocol (do these in the same change — don't let this doc drift from `git log`):**
- When a finding ships or is deferred: update its **Disposition** line below (date + commit SHA(s)
  + one line on what actually shipped) AND the phase row in the rollout table.
- When a phase closes: add a dated **Changelog** entry, then `git mv` its spec + plan to
  `docs/shipped/` with their `Status:` lines flipped to shipped (date + SHAs).
- New review pass = append a new dated section; never overwrite prior findings.

| Phase | Theme | Findings | Status |
|------:|-------|----------|--------|
| 1 | Security quick wins | #3, #4, #5 | ✅ Done (2026-07-12) |
| 2 | Auth/session hardening | #1, #6, #7, #8, #13, #31 | 🚧 In progress — split into 4 specs (see below) |
| 3 | Dashboard correctness | #2, #9, #10, #11, #12 | ◻ Planned |
| 4 | Data layer & contracts | #16, #17, #22, #23, #24 | ◻ Planned |
| 5 | Infra / CI / ops | #20, #32, #33, #34, #35, #36, #37 | ◻ Planned |
| 6 | UX & cleanup | #27, #40, #41, #42 | ◻ Planned |
| — | Backlog (unscheduled) | #14, #15, #18, #19, #21, #25, #26, #28, #29, #30, #38, #39, #45 | ◻ Triage |

Phase 1 spec/plan: `docs/shipped/security-quick-wins-design.md` + `-plan.md` (moved on close-out).

**Phase 2 is four specs, not one.** Its six findings share a theme but not a mechanism, so each
ships independently rather than as one long plan:

| # | Spec | Findings | Status |
|--:|------|----------|--------|
| 1 | `docs/shipped/session-revocation-design.md` | #6, #7, #8 (authz half), #44 | ✅ Shipped 2026-07-17 |
| 2 | not written | #1 (frontend auth-boundary reset) | ◻ Planned |
| 3 | not written | #13 (Argon2 off the event loop) | ◻ Planned |
| 4 | not written | #31 (email normalization + config validation) | ◻ Planned |

Spec 1 also folds in an unlogged defect (`/auth/refresh` has no CSRF guard and no rate limit) and
logs two new ones: #43 (login timing oracle, for spec 3) and #44 (`/auth/refresh` CSRF + rate
limit, fixed in spec 1).

### Changelog
- **2026-07-12** — Phase 1 shipped: #3 (`f1fdc11`, fixup `ac9f197`), #4 (`c879165`), #5 (`ed690c0`).
- **2026-07-16** — All 39 open findings re-verified against the code (adversarial pass, 7 parallel
  reviewers). **Zero refuted**; corrections recorded below. #42's documentation sub-items closed
  by the docs commits (`3b45f1e`, `9c7f148`).
- **2026-07-16** — List/item drag-and-drop reordering shipped (`8543fab`, `35a1ea5`), closing
  #14's reorder-input slice and #30's nonnegative sort-order slice (both now ◐ partial).
  Reorder SSE events patch caches from the event payload instead of refetching; generalising
  that pattern (with #8 as its prerequisite) is designed in `docs/shipped/sse-hardening-design.md`.
- **2026-07-16** — SSE hardening shipped (`44a9e15`, `8f2028f`, `6fd1f31`): #8's **eviction half**
  closed (#8 stays ◐ — its authorization half is the security one and moves into Phase 2 with #7).
  Payload-carrying events now cover list item update/check, so those no longer fan a GET out to
  every open tab. Streams rejected on an HTTP error now refresh and reconnect with backoff, and
  ask for a resync explicitly because a fresh `EventSource` sends no `Last-Event-ID`.
- **2026-07-17** — Phase 2 spec 1 (session revocation) shipped (`22c9dfd`, `54f7572`, `4089d88`,
  `dfd8234`, `f182ea2`): **#6, #7, #8, #44 all ✅**. The app now has sessions — one row per login,
  stable across rotation — so credentials revoke per device, token reuse is detected, and streams
  end when authority is withdrawn. Existing sessions were revoked by the migration: everyone
  signs in once more. Two findings logged during the design pass: #43 (login timing oracle,
  deferred to spec 3) and #44 (fixed here). An auth-dependency refactor (one cached decode+query)
  and a critical frontend CSRF fix rode along. Phase 2 remainder: #1, #13 (+#43), #31.
- **2026-07-17** — #38 **token/session half shipped** (`a92bc28`): a scheduled,
  advisory-locked retention sweep deletes expired refresh/verification/reset tokens and idle,
  fully-expired sessions — the first pruning machinery in the app. Logged #45 (horizontal-scaling
  readiness) during the design. #38 stays ◐ partial: collection pagination + activity/notification
  retention (the *should-grow* half) remain open.
  *Follow-ups logged during this work (Minor, not blocking):* a revoked session 401s with the
  message "User not found"; `logout` no-ops if the refresh cookie is absent though the session is
  identifiable from the access cookie; the refresh route re-queries `User` after `live_session`
  already validated it (dead `if not user` branch); `_drop_streams` runs just before its commit
  rather than after (self-healing); 429 on `/refresh` reads as a logout and the limiter buckets
  per-IP (household NAT). Row-retention analysis for `refresh_tokens`/`sessions` folded into #38.
- **2026-07-17** — **The five minor follow-ups above are fixed** (`6ad1243` backend, `ff85c0e` frontend): the 401 detail is
  now "Session is no longer valid"; `logout` takes the session from the access token
  (`get_current_session`) so it revokes even with no refresh cookie; `live_session` returns
  `(session, user)` so `rotate_refresh_token` hands the router the user — no re-query, dead branch
  gone; `revoke_session`/`revoke_user_sessions` now return the revoked ids and the routers call
  `drop_session_streams(...)` **after** commit (the theft path carries the id on `RefreshRejected`);
  and `tryRefresh` distinguishes a 429 (`'rate-limited'`) so `apiFetch`/`useSSE` back off instead of
  logging the user out. Tests added: logout-without-refresh-cookie (backend), `tryRefresh` 429
  mapping + SSE reconnect-not-logout (frontend). **Deliberately kept:** the limiter still buckets
  per-IP — acceptable at household scale (a NAT'd household shares the generous 30/min), and
  keying `/refresh` per-user isn't possible when the access token has expired.

## Validation pass — 2026-07-16

Every open finding was independently re-verified against the current code before Phase 2
implementation. All hold. Corrections that change scope, mechanism, or line refs (read these
before implementing the finding; anything not listed verified as written, modulo small line drift):

- **#1** — also reset the *module-level* machinery in `stores/dashboard.ts` (in-flight promise,
  request serials, debounce timer, lines 64-71); a store-fields-only reset is insufficient.
- **#2** — the reproducible blocker is the soft-deleted list/event row itself (`dashboards.id`
  FKs have no `ondelete`, `q6s8u0w2y4a6:121,125`); "items under a soft-deleted list" only block
  via their parent list. Fix should also delete items of soft-deleted lists to avoid orphans.
  `dashboard_widgets` already cascades.
- **#8** — mechanism correction: the evicted generator is not waiting forever (it wakes every 5s
  and TCP teardown still ends it); the defect is that queue-overflow eviction sends no closed
  sentinel, so an evicted-but-connected client silently receives nothing. The comment in
  `sse/manager.py` claiming the generator detects closure is false.
- **#9** — root cause located: `handleLayoutChange` (`DashboardGrid.tsx:108-114`) has no
  `isMobile` guard (unlike `handleLayoutStop`), letting the one-column projection pollute the
  draft.
- **#10** — the "failed share adds clear the search" sub-claim is not in `handleAddShare`
  (which catches and toasts); if real, it lives in the share-search child/`useShareSearch` —
  verify separately.
- **#13** — call sites drifted to `auth.py:223,348,371,489,501`.
- **#14** — partially narrowed by Phase 1: `DashboardUpdate`/`ListItemUpdate` now have
  `PatchModel` + `extra="forbid"` (`ed690c0`). `ListCreate`/item text/passwords were already
  bounded. There is no bulk-reorder endpoint — drop that DTO from the proposal. Still open:
  dashboard name bounds, layout/widget-config typing, `ProfileUpdate`, sort_order `ge=0`.
- **#15** — the multi-process bucket divergence is latent (single worker today); the live defect
  is all users collapsing into the Caddy container's IP bucket.
- **#16** — daily/weekly recurrence already has skip-ahead; only monthly/yearly iterate from
  series start. A 366-day cap bounds per-event expansion but not the all-events/all-overrides
  load.
- **#17** — fan-out is now list-reminders-only (occurrences are one separate request) and costs
  per cold load/invalidation, not per render.
- **#18** — direct child-share *creation* is already blocked (409 stubs); the real complexity is
  unrestricted string types, missing FKs, and the inherited-access query fan-out.
- **#20** — drift is worse than written: ORM `notification.user_id` lacks the FK *and* migration
  `f4g7i5e1h9d6` carries an orphan `group_id` column absent from the ORM. Reconcile both.
- **#23** — error paths are now typed via `readError`; success bodies remain unvalidated casts.
- **#25** — notification flush is already batched (only `refresh` is per-row); child row deletes
  are already set-based — only the per-child share cleanup loops.
- **#27** — `CreateDashboardModal` labelling is fine (`aria-labelledby` present); the gaps are
  ConfirmDialog (hardcoded "Delete", no focus trap/restore, unlinked message), sidebar popover
  (no `aria-expanded`/Escape), Toaster (no live region), hover-only actions.
- **#28** — frontend already gates queries at ≥2 chars; the API still allows `min_length=1` and
  has no rate limit or active/verified filter.
- **#30** — the reminder-offset constraint is defensive-only (`calendar_reminders` is dead
  schema, see #41). Extra hazard found: a bogus occurrence override persists an orphan row while
  responding as if cancelled.
- **#31** — `frontend_base_url` scheme validation already exists (`86472fb`); remaining scope is
  email canonicalization, environment enum, and secret-entropy startup checks.
- **#36** — `backend/.dockerignore` and `frontend/.dockerignore` now exist, but the frontend
  prod image builds from the repo **root** (`deploy.sh:16-19`), which they don't cover — a root
  `.dockerignore` is still needed. Node mismatch confirmed (CI 22 vs `node:20-alpine`).
- **#38** — notifications are silently capped at 50, not unbounded; the unbounded-growth risk is
  dashboards/lists collections and token/activity tables.
- **#41** — `App.css` is an empty file (not leftover styles); all other dead surfaces confirmed.
- **#42** — Pydantic v2 deep-copies field defaults, so the mutable-default sub-item is cosmetic,
  not a correctness fix. When fixing the email bearer-URL logging, preserve a token-free local
  dev affordance (it's currently the only way to get tokens locally).

## Review baseline

- Frontend validation passed: Biome, TypeScript, 18 Vitest files / 77 tests, and the Vite production build. The build emitted one 471.82 kB JavaScript chunk (133.34 kB gzip).
- Backend Ruff formatting/lint and `ty` checks passed.
- The backend pytest suite could not run in this review environment because its session bootstrap requires a Docker socket for Testcontainers (`backend/tests/conftest.py:19-45`). This is an environment limitation, not a reported test failure.
- Existing modifications to `backend/pyproject.toml` and `backend/uv.lock` predated this review and were not changed.

## Ranked findings

### 1. Reset dashboard state at the authentication boundary

- **What & where** — `frontend/src/stores/auth.ts:45-51,95-102`; `frontend/src/stores/dashboard.ts:64-71,301-318`; `frontend/src/pages/DashboardsPage.tsx:33-35`
- **Problem** — Logout resets notifications and resource caches but not dashboard summaries, the active dashboard, in-flight requests, timers, or pending mutations. A second account in the same tab can reuse the first account's `summariesLoaded` data, and a late first-account request can repopulate state after logout. This is a privacy boundary failure.
- **Proposal** — Add a dashboard session reset that clears store and module-level state. Invoke it on unauthenticated initialization, logout, and before installing a new user; gate responses with a session generation or `AbortController`. Add an account-switch regression test.
- **Effort / Risk** — Medium / Medium; asynchronous response races need an explicit policy.
- **Impact** — Prevents cross-account dashboard metadata exposure and stale account state.

### 2. Make dashboard deletion honor all owned rows

- **What & where** — `backend/app/routers/dashboards.py:580-598`; `backend/app/models/list.py:31,48`; `backend/app/models/calendar.py:30`; `backend/app/routers/lists.py:281-308`
- **Problem** — Dashboard deletion selects only children whose `deleted_at IS NULL`, while child foreign keys do not cascade. Any previously soft-deleted list or event remains and makes PostgreSQL reject the final dashboard delete; items under a soft-deleted list add another blocker.
- **Proposal** — Define terminal ownership with `ON DELETE CASCADE` for dashboard-to-list-to-item and dashboard-to-event relationships, with matching ORM passive-delete behavior. Alternatively, hard-delete all children regardless of soft-delete state. Test deletion after soft-deleting both child types against a migrated schema.
- **Effort / Risk** — Medium / Medium; requires constraint migration and destructive-semantics review.
- **Impact** — Fixes a reproducible core lifecycle failure and makes cleanup atomic.

### 3. Stop replaying consumed email-verification links into new sessions

- **What & where** — `backend/app/routers/auth.py:253-278`; `backend/tests/test_auth.py:91-108`
- **Problem** — A token whose `used_at` matches `email_verified_at` is accepted again and creates another authenticated session. Until expiry, a verification URL leaked through email forwarding, history, or logs is a reusable passwordless login credential; the current test enshrines this behavior.
- **Proposal** — Consume the token exactly once under row lock or atomic update. A replay may return an "already verified" result, but must not create cookies or a refresh token. Replace the replay test with security and concurrency cases.
- **Effort / Risk** — Small / Low; the verification page may need to direct already-verified users to login.
- **Impact** — Closes an authentication replay window.
- **Disposition** — ✅ Done 2026-07-12 (`f1fdc11`, fixup `ac9f197`). Consumed-token replay now returns 409 with no session; `used_at` is disambiguated from resend-superseded tokens (which still return 400). Frontend routes 409 → "already verified, sign in".

### 4. Treat failed list and item deletes as failures

- **What & where** — `frontend/src/api/lists.ts:121-126,157-166`; `frontend/src/resources/listData.ts:230-239,283-299`
- **Problem** — The two DELETE wrappers ignore `Response.ok`. A 403, 404, or 500 resolves successfully, after which the resource layer removes server-owned data from local caches and presents a false-success disappearance.
- **Proposal** — Route every mutation through a shared `requestVoid`/`expectOk` helper that parses a typed API error and rejects on non-2xx. Add 4xx/5xx tests for list and item deletion.
- **Effort / Risk** — Small / Low.
- **Impact** — Eliminates a silent client/server divergence with a narrow change.
- **Disposition** — ✅ Done 2026-07-12 (`c879165`). Added shared `requestVoid` in `frontend/src/api/http.ts` (also new home for `ApiError`/`readError`); both DELETE wrappers now reject a typed `ApiError` on non-2xx.

### 5. Reject empty PATCH bodies before authorization and mutation

- **What & where** — `backend/app/routers/lists.py:375-405`; `backend/app/routers/calendar.py:247-284`; `backend/app/routers/dashboards.py:522-542`
- **Problem** — List-item edit permission is checked only when fields are present, but `{}` still changes `updated_by`, commits, logs, and broadcasts. A viewer can therefore write audit state. Empty dashboard/calendar patches also generate false history.
- **Proposal** — Reject empty patch models with 422 and assert write permission unconditionally on mutation endpoints. Add viewer/editor tests for `{}` across resources.
- **Effort / Risk** — Small / Low.
- **Impact** — Closes a real authorization gap and restores audit accuracy.
- **Disposition** — ✅ Done 2026-07-12 (`ed690c0`). Shared `PatchModel` base (`backend/app/schemas/common.py`) rejects empty bodies with 422 before auth/mutation on list-item/calendar/dashboard PATCH; list-item edit permission is now asserted unconditionally.

### 6. Make refresh and password-reset tokens truly single-use under concurrency

- **What & where** — `backend/app/routers/auth.py:326-352,387-415`; `backend/tests/test_auth.py:241-252`
- **Problem** — Neither lookup atomically consumes or locks its row. Concurrent requests can both observe a valid token and commit two password resets or two successor refresh tokens. Sequential tests cannot expose this race, and refresh-family reuse detection is absent.
- **Proposal** — Use `UPDATE ... WHERE used/revoked = false RETURNING` or `SELECT ... FOR UPDATE`; introduce refresh token families and revoke the family on reuse. Test concurrent requests using separate database sessions.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Makes token rotation and one-time reset guarantees hold in real multi-tab/client use.
- **Disposition** — ✅ Done 2026-07-17 (`54f7572`, `4089d88`, `dfd8234`). Both consumes are now
  atomic `UPDATE … WHERE … RETURNING`, tested with a real two-connection `concurrent_sessions`
  fixture (the savepoint harness cannot express a race). Refresh gained a session/family with a
  **10s grace window**: a replay inside it mints a successor (the multi-tab stampede), a replay
  outside it revokes the session (reuse detection). Expiry is checked before reuse, so a
  week-away token reads as expiry, not theft.
  **Honest scope note.** The grace window means the *refresh* double-mint is now deliberately
  *allowed* inside 10s (tabs share one cookie and expire together, so an atomic consume without a
  window would 401 the loser and log real users out). So atomicity did not close the refresh
  double-mint — it was already bounded by the window; what it added is **reuse detection** (new)
  and a genuinely-closed **password-reset** race (no grace window there, so the atomic consume
  bites — proven RED against a read-then-write). The `pick-exactly-one-winner` test is what makes
  the property regression-proof. Token *families*/`FOR UPDATE` from the proposal were not built;
  the session row plus atomic consume achieve the same guarantee more simply.

### 7. Revoke sessions when credentials change

- **What & where** — reset revocation at `backend/app/routers/auth.py:342-351`; authenticated password change at `backend/app/routers/auth.py:475-498`; session metadata at `backend/app/models/refresh_token.py:20-24`
- **Problem** — Password reset revokes refresh tokens, but an authenticated password change does not. A stolen refresh token remains valid after the owner changes their password; existing access tokens and SSE streams also continue.
- **Proposal** — Revoke all refresh sessions on password change, optionally preserving a clearly identified current session. Add a per-user session/token version checked during access authentication and expose device sessions using the existing metadata fields.
- **Effort / Risk** — Medium / Medium; changes session UX.
- **Impact** — Gives password changes the containment behavior users expect.
- **Disposition** — ✅ Done 2026-07-17 (`dfd8234`). Password change revokes every session except
  the caller's; reset revokes all (unauthenticated flow — no session to spare); logout revokes the
  current one. Because access authentication now joins `sessions` per request, revocation is
  **immediate** rather than bounded by the 15-minute JWT — the "session/token version" the proposal
  asked for is the `sessions` row itself. The metadata columns moved to `sessions` but the
  device-list UI is deliberately not built (the row makes it cheap later). Asserted at the DB
  level, and the "spare the caller" behaviour proven RED against a revoke-everything sabotage.

### 8. Bound SSE authorization and close evicted streams

- **What & where** — `backend/app/routers/sse.py:22-47`; `backend/app/sse/manager.py:53-65`; `backend/tests/test_sse.py:48-118`
- **Problem** — Authentication happens only when the stream opens, so a stream can receive household events beyond the 15-minute JWT lifetime or after account/session revocation. Queue overflow removes a client from the registry but never signals its generator, leaving the connection waiting forever despite the comment claiming closure will be detected.
- **Proposal** — End connections at token expiry and require reauthentication; optionally recheck a session version. Add a closed sentinel/flag for queue eviction and tests for overflow, expiry, cancellation, and user/session revocation.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Prevents stale-authority data exposure and leaked streaming tasks.
- **Disposition** — ✅ Done. Eviction half 2026-07-16 (`44a9e15`, `6fd1f31`); authorization half
  2026-07-17 (`22c9dfd`, `dfd8234`). Both halves now closed, but the authorization half was
  **not** built as the proposal describes, and the difference is deliberate:
  > **Claim (stated so it can be checked, not in compliance terms): a revoked session stops
  > streaming within 30 seconds, and stops being accepted on requests immediately.**

  The proposal — *"end connections at token expiry and require reauthentication"* — was written
  when the JWT was the only authority. This work moved authority to the `sessions` row, at which
  point bounding the JWT stops *being* a way to bound authorization and becomes a poor *proxy* for
  it: a session revoked one minute after a refresh would stream on for fourteen more, while every
  tab would resync on the same 15-minute boundary (a GET storm the SSE-hardening work exists to
  avoid). So instead the stream **revalidates its session every 30s** (the guarantee, checked on
  every loop iteration — the existing 5s `wait_for` is an idle timeout, not a heartbeat, so a busy
  stream would never hit it), and `revoke_session` also drops the stream **in-process instantly**
  as a *non-load-bearing* optimisation (if it misfires or a second worker appears, the 30s check
  still holds). `REVOKED_SENTINEL` ends the stream with no resync, distinct from eviction's
  `CLOSED_SENTINEL`. Single-worker dependency is the manager's existing assumption; cross-process
  revocation is #21, still deferred. Note this replaces the earlier "still open" text: the
  client-side reconnect (`6fd1f31`) turned out to be the prerequisite, not the fix.

### 9. Separate canonical dashboard layout from responsive projection

- **What & where** — `frontend/src/components/dashboard/DashboardGrid.tsx:26-43,81-92,108-124,142-150`; `frontend/src/components/dashboard/DashboardGrid.test.tsx:55-74`
- **Problem** — Mobile rendering projects every widget to one column, but `onLayoutChange` can write the projected layout back into the draft. Returning to desktop and moving a widget can persist the mobile projection over the desktop arrangement. Existing tests do not cover breakpoint transitions.
- **Proposal** — Keep one canonical persisted layout separate from derived viewport layouts. Ignore library layout events in projected/read-only modes or persist layouts explicitly per breakpoint. Test mobile-to-desktop transitions and prove projections never trigger saves.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Prevents accidental destruction of a user's dashboard arrangement.

### 10. Standardize mutation success and failure contracts

- **What & where** — `frontend/src/stores/dashboard.ts:349-360,417-437,568-579,607-628`; `frontend/src/pages/DashboardEditorPage.tsx:170-174`; `frontend/src/components/dashboard/DashboardSettingsModal.tsx:95-165`; `frontend/src/components/dashboard/CreateDashboardModal.tsx:50-69`
- **Problem** — Actions inconsistently toast-and-resolve, toast-and-rethrow, or allow raw rejection. Failed widget adds/renames can close dialogs, failed share adds clear the search, and create failures can become unhandled event rejections. User input is lost despite no server success.
- **Proposal** — Make mutations consistently reject a normalized `ApiError` or return a typed `Result`; emit errors in one layer and close/reset UI only after confirmed success. Add failure-path component tests.
- **Effort / Risk** — Medium / Medium; many call sites need a mechanical migration.
- **Impact** — Removes misleading success flows and preserves recoverable input.

### 11. Serialize and coalesce dashboard layout saves

- **What & where** — `frontend/src/components/dashboard/DashboardGrid.tsx:116-124`; `frontend/src/stores/dashboard.ts:537-565`; `frontend/src/api/dashboards.ts:142-161`
- **Problem** — Drag/resize saves are fire-and-forget. Two gestures can submit the same base version; response reordering can install an older layout or create a conflict against the user's own prior request.
- **Proposal** — Maintain one in-flight save per dashboard plus one latest pending layout. Send the pending value only after receiving the new version; expose saving/error state and define navigation/unmount flush behavior.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Makes rapid editing reliable and removes self-created 409 conflicts.

### 12. Invalidate time-dependent dashboard data at local midnight

- **What & where** — `frontend/src/resources/agendaData.ts:38-47,104-123`; `frontend/src/resources/scopedQuery.ts:138-143`; `frontend/src/components/dashboard/widgets/CalendarWidget.tsx:36-44`; `frontend/src/pages/CalendarPage.tsx:62-63,98`
- **Problem** — Agenda keys omit the day even though fetch windows and reminder classification depend on it; `today` is memoized once and cached data has no time-based staleness. An always-on household display can show yesterday indefinitely after midnight.
- **Proposal** — Add a shared local-day hook scheduled for the next midnight, including DST handling. Include day/window in query keys or invalidate at midnight and revalidate on focus/visibility.
- **Effort / Risk** — Medium / Low-Medium.
- **Impact** — Keeps the core wall-dashboard use case trustworthy across days.

### 13. Move Argon2 work off the async event loop

- **What & where** — `backend/app/auth/hashing.py:4-16`; call sites `backend/app/routers/auth.py:221-224,342-343,364-367,484-496`
- **Problem** — Argon2 is deliberately CPU/memory expensive, yet hashing and verification run synchronously in async request handlers. Authentication bursts stall unrelated API requests and every SSE task on the event-loop thread.
- **Proposal** — Execute password operations through `anyio.to_thread.run_sync` with a bounded capacity limiter; tune parameters and load-test concurrent auth traffic.
- **Effort / Risk** — Small / Low-Medium.
- **Impact** — Preserves service responsiveness and reduces an easy denial-of-service amplifier.

### 14. Validate dashboard, layout, widget, profile, and reorder inputs at the boundary

- **What & where** — `backend/app/schemas/dashboards.py:59-84`; DB name limit `backend/app/models/dashboard.py:15`; `backend/app/schemas/auth.py:7-15,79-80`; `backend/app/schemas/lists.py:42-49`; persistence `backend/app/routers/dashboards.py:682,728-729,875`
- **Problem** — Dashboard names/config/layout are effectively arbitrary JSON/strings, despite a 100-character DB limit. Blank display names, duplicate or malformed layout IDs/coordinates, negative/duplicate sort orders, unbounded mutation headers, and invalid widget config can reach persistence or fail as 500s.
- **Proposal** — Use trimmed bounded fields, `extra='forbid'`, typed layout items with grid limits and unique widget IDs, discriminated per-widget config/resource models, bounded headers/body size, and a transactional bulk-reorder DTO.
- **Effort / Risk** — Medium / Medium; requires coordinated client contract updates.
- **Impact** — Converts corrupting/runtime failures into deterministic 422s and makes OpenAPI useful.
- **Disposition** — ◐ Partially done 2026-07-16 (`8543fab`). The reorder-input slice landed with
  list/item reordering: `ItemReorder`/`ListReorder` DTOs (`extra="forbid"`, `min_length=1`,
  bounded, duplicate ids rejected at the schema layer → 422) behind transactional bulk-reorder
  endpoints that renumber under a row lock with strict id-set equality (409 otherwise);
  `sort_order` removed from `ListItemUpdate`, so arbitrary/negative/duplicate orders can no
  longer be PATCHed in; the `sort_order ge=0` gap is closed at the DB instead (see #30). Still
  open: dashboard name bounds, typed layout/widget-config models, `ProfileUpdate`, bounded
  mutation headers/body size.

### 15. Configure rate limiting for the trusted-proxy topology

- **What & where** — `backend/app/limiter.py:1-4`; `backend/Dockerfile.prod:21`; `Caddyfile.prod:3-11`; `backend/app/routers/auth.py:208-210,283-318,355-357`
- **Problem** — SlowAPI keys on `request.client`, while Caddy is a separate container and Uvicorn has no explicit trusted-proxy setup. Limits can collapse all users behind Caddy into one bucket; blindly trusting forwarded headers would instead allow spoofing. In-memory buckets also diverge across processes.
- **Proposal** — Trust only the Caddy network, parse the validated forwarding chain, and use a shared limiter store with endpoint, IP, and account keys. Test independent client IPs and spoofed headers through Caddy.
- **Effort / Risk** — Small-Medium / Medium; proxy trust must be narrowly scoped.
- **Impact** — Makes brute-force controls effective without household-wide lockouts.

### 16. Make calendar work proportional to the requested window

- **What & where** — `backend/app/routers/calendar.py:167-224`; `backend/app/services/calendar.py:102-181`; `backend/app/models/calendar.py:23-28`
- **Problem** — A window request loads every active event for every accessible dashboard, then all overrides, expands recurrence in Python, and sorts globally. The `starts_at` index cannot help. Monthly/yearly rules iterate from series start, so latency grows with total history and recurrence age.
- **Proposal** — Split recurring/non-recurring candidate SQL, add dashboard/deletion/time indexes and persisted recurrence bounds, window-filter overrides, and use a proven RFC 5545 recurrence library with direct seeking or a rolling occurrence materialization strategy. Cap responses and benchmark worst cases.
- **Effort / Risk** — Large / Medium-High; recurrence semantics and data migration need careful tests.
- **Impact** — Bounds calendar latency/memory and improves recurrence correctness at scale.

### 17. Replace the agenda's client-side 1+N request fan-out

- **What & where** — `frontend/src/resources/agendaData.ts:115-123`; `frontend/src/resources/listData.ts:154-158`; `frontend/src/api/lists.ts:52-85`
- **Problem** — Agenda loads list summaries and then one full detail endpoint per active list solely to find due unchecked items. Network requests, backend queries, and irrelevant payload grow linearly with list count.
- **Proposal** — Add a dashboard-scoped agenda/reminder endpoint returning only due list items plus occurrences, or at minimum a batch list-detail endpoint. Cache it by dashboard and time window.
- **Effort / Risk** — Medium-Large / Medium; adds a cross-module read model.
- **Impact** — Removes a visible 1+N path and gives the home dashboard one efficient data source.

### 18. Commit to one visibility model and enforce it in the schema

- **What & where** — `backend/app/models/share.py:12-46`; rejecting child-share routes `backend/app/routers/lists.py:448-494` and `backend/app/routers/calendar.py:384-430`; generic inheritance code `backend/app/services/shares.py:179-296,382-475`
- **Problem** — Runtime visibility is dashboard-owned, but a polymorphic share table and hundreds of lines still model direct list/event shares and inherited access. Type/role fields are unrestricted strings, resource/principal IDs lack ownership FKs, and unsupported branches add query and audit complexity.
- **Proposal** — Record an ADR for dashboard-owned visibility and replace the table with `dashboard_shares(dashboard_id, user_id, role)` using cascading FKs/checks/uniqueness; remove child-share endpoints/helpers/types. If future per-resource sharing is required, model typed association tables behind one policy engine rather than preserving both systems.
- **Effort / Risk** — Large / Medium; migration must audit existing rows.
- **Impact** — Shrinks the authorization state space and makes visibility database-enforceable.

### 19. Validate share targets and use atomic upserts

- **What & where** — `backend/app/services/shares.py:315-379,422-450`; `backend/app/models/share.py:27-46`; share endpoints `backend/app/routers/dashboards.py:956-1003`
- **Problem** — The API can store self, nonexistent, deleted, or unverified user principals; unresolved targets display as "Unknown." Read-before-insert sharing races can violate uniqueness, while bulk initial inserts silently ignore duplicate targets.
- **Proposal** — Validate an active target and reject self-sharing. Use `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, reject duplicate initial targets explicitly, and preferably gain user/dashboard FKs through finding 18.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Restores deterministic authorization data and prevents ghost shares/500 races.

### 20. Run tests against Alembic's deployed schema

- **What & where** — `backend/tests/conftest.py:22-45`; `backend/alembic/env.py:27-47`; `.github/workflows/ci.yml:31-35`; drift at `backend/app/models/notification.py:21-25` versus `backend/alembic/versions/f4g7i5e1h9d6_add_notifications.py:23-41`
- **Problem** — Tests use `Base.metadata.create_all()` rather than `alembic upgrade head`, so migration order, backfills, stale types, server defaults, and metadata drift are invisible. The notification user FK already differs between migration and ORM.
- **Proposal** — Add a PostgreSQL migration job that upgrades an empty database, runs `alembic check`, and validates schema invariants. Run API tests against that database in CI and add an upgrade test from a supported prior snapshot.
- **Effort / Risk** — Medium / Low.
- **Impact** — Catches deploy-blocking schema defects before self-hosters encounter them.

### 21. Make SSE delivery durable and multi-process

- **What & where** — `backend/app/sse/manager.py:26-69`; commit-before-broadcast at `backend/app/routers/dashboards.py:499-502`; reconnect behavior `backend/app/routers/sse.py:17-36`; durable IDs `backend/app/models/activity.py:50-75`
- **Problem** — The module singleton only reaches clients in the mutating process. A crash after commit loses delivery, multiple workers split streams, and reconnect ignores the persisted event cursor in favor of an expensive generic resync. Notifications do not carry event IDs.
- **Proposal** — Stage a transactional outbox with a dispatcher and Redis or PostgreSQL pub/sub; give all event types durable IDs and replay authorized events after `Last-Event-ID`, retaining bounded resync only as fallback.
- **Effort / Risk** — Large / Medium-High.
- **Impact** — Enables reliable live updates, rolling deploys, and horizontal scaling.

### 22. Fix notification counts, deduplication, and pagination

- **What & where** — backend limit `backend/app/routers/notifications.py:31-43`; frontend overwrite `frontend/src/stores/notifications.ts:33-40`; SSE prepend `frontend/src/stores/notifications.ts:100-104`; unused activity cursor `frontend/src/pages/NotificationsPage.tsx:34-38`
- **Problem** — Opening the first 50 notifications overwrites the separately fetched unread total with unread rows in that page, undercounting when more exist. Repeated SSE IDs double-increment unread, records beyond 50 are unreachable, and the activity cursor is never used.
- **Proposal** — Return cursor envelopes with an authoritative unread count, normalize notifications by ID with idempotent unread accounting, and implement load-more/infinite pagination for both tabs.
- **Effort / Risk** — Medium / Low-Medium.
- **Impact** — Produces correct badges and makes "View all" truthful as history grows.

### 23. Generate and validate frontend API/event contracts

- **What & where** — assertions in `frontend/src/api/dashboards.ts:72-99`, `frontend/src/api/lists.ts:52-85`, `frontend/src/api/calendar.ts:82-121`; loose widgets `frontend/src/api/dashboards.ts:16-24`; SSE casts `frontend/src/hooks/useSSE.ts:72-105`
- **Problem** — `res.json() as ...` provides no runtime validation, types duplicate backend DTOs by hand, widget config is `Record<string, unknown>`, and SSE event names are strings. Backend drift or malformed data can enter stores despite strict TypeScript.
- **Proposal** — Generate TypeScript types/client code from FastAPI OpenAPI, validate network boundaries with generated runtime schemas, and model widgets/SSE as discriminated unions. Fail CI on generated-client drift.
- **Effort / Risk** — Medium-Large / Medium.
- **Impact** — Detects cross-stack contract drift before production and removes unsafe casts.

### 24. Consolidate server state on a lifecycle-aware query layer

- **What & where** — `frontend/src/resources/scopedQuery.ts:38-229`; month-window entries `frontend/src/resources/calendarData.ts:23-35`; dashboard async machinery `frontend/src/stores/dashboard.ts:312-535`; search cancellation `frontend/src/hooks/useShareSearch.ts:26-62`
- **Problem** — Custom caches never evict until logout and lack stale/gc times, cancellation, retries, focus/online refresh, and status distinctions. Navigating windows accumulates map entries, abandoned requests continue, and the dashboard store separately reimplements dedupe/queue logic.
- **Proposal** — Migrate server state to TanStack Query with centralized keys, session-wide clear, abort signals, stale/gc policy, mutation invalidation, and SSE cache updates. If retaining the custom layer, implement those lifecycle guarantees explicitly. Keep Zustand for client UI state.
- **Effort / Risk** — Large / Medium-High; incremental per-resource migration is advisable.
- **Impact** — Bounds memory, reduces bespoke concurrency code, and standardizes loading/error behavior.

### 25. Remove avoidable access/query N+1s

- **What & where** — `backend/app/services/shares.py:74-116,179-210`; notification refresh loop `backend/app/sse/events.py:81-90`; dashboard delete loop `backend/app/routers/dashboards.py:580-593`
- **Problem** — Dashboard access still invokes irrelevant inherited-resource discovery, each notification is refreshed separately, and child share cleanup executes per child. These add round trips to common shared reads and large deletes.
- **Proposal** — Add a dashboard-specific access query using owner-or-share `EXISTS`, obtain notification defaults in one flush/RETURNING path, and use set-based cleanup by resource type and subquery/`IN`. Add representative SQL query-count tests.
- **Effort / Risk** — Medium / Low-Medium.
- **Impact** — Reduces database latency while simplifying permission reasoning.

### 26. Standardize API errors and visible recovery states

- **What & where** — exception setup `backend/app/main.py:27-40`; frontend error readers `frontend/src/api/auth.ts:30-33`, `frontend/src/api/calendar.ts:77-80`; false-empty calendar `frontend/src/pages/CalendarPage.tsx:86-93,387-390`; swallowed notifications `frontend/src/stores/notifications.ts:33-92`
- **Problem** — Integrity races and FK violations become generic 500s; error bodies/status preservation vary by endpoint. On the client, outages can render as "No events" or zero unread, and activity rejection can be unhandled. There is no correlation ID.
- **Proposal** — Prevent known conflicts atomically, translate narrow `IntegrityError` cases, emit RFC 7807-style error codes plus request IDs, and centralize typed client parsing. Preserve stale data and render explicit retryable error states instead of valid empty values.
- **Effort / Risk** — Medium / Low-Medium.
- **Impact** — Makes failures diagnosable and user-recoverable across both stacks.

### 27. Use accessible dialog, popover, feedback, and action primitives

- **What & where** — dialogs `frontend/src/components/ui/ConfirmDialog.tsx:11-50`, `frontend/src/components/dashboard/CreateDashboardModal.tsx:93-105`, `frontend/src/components/lists/CreateListModal.tsx:34-46`; popovers `frontend/src/components/layout/Sidebar.tsx:155-208`; toast `frontend/src/components/ui/Toaster.tsx:17-49`; hover actions `frontend/src/components/dashboard/DashboardCard.tsx:69-155`
- **Problem** — Dialogs duplicate incomplete focus trapping/restoration and labelling; popovers lack expanded/control semantics and keyboard dismissal. Confirm always says "Delete" even for archive/remove. Toasts/form errors are not consistently announced, while important card actions are hover-invisible to keyboard/touch users and use small targets.
- **Proposal** — Adopt one tested Dialog/Popover primitive (React Aria/Radix or a local equivalent), parameterize action label/tone, add live-region and field-linked errors, and replace hover-only actions with a visible overflow menu using at least 44px touch targets and `focus-within` behavior.
- **Effort / Risk** — Medium / Low-Medium.
- **Impact** — Makes core workflows usable by keyboard, screen reader, and touch while removing duplicated modal code.

### 28. Protect user discovery privacy and search performance

- **What & where** — `backend/app/routers/users.py:12-32`; `backend/app/models/user.py:10-18`; `frontend/src/hooks/useShareSearch.ts:26-73`
- **Problem** — Any authenticated account can substring-scan names and full emails, including deleted or unverified users. Leading-wildcard `ILIKE '%q%'` cannot use the existing exact email index and supports cheap enumeration.
- **Proposal** — Define the household/discovery boundary, filter active verified users, mask email unless required for an explicit invite, require a longer query, rate-limit discovery, and add prefix/trigram indexes to match the chosen semantics.
- **Effort / Risk** — Small-Medium / Medium; visibility is a product decision.
- **Impact** — Reduces PII exposure and keeps sharing search responsive.

### 29. Add indexes and uniqueness for actual dashboard/widget paths

- **What & where** — `backend/app/models/dashboard.py:11-29`; queries `backend/app/routers/dashboards.py:231-245,618-623,788-800`; reverse lookups `backend/app/services/shares.py:179-205,289-295`
- **Problem** — Dropping the one-dashboard-per-user unique index left `dashboards.user_id` unindexed. Widget lookups use dashboard/resource tuples or reverse resource IDs, but only `dashboard_id` is indexed; duplicate resource widgets rely on read-before-insert.
- **Proposal** — Add `(user_id, archived, updated_at)` and `(resource_type, resource_id, dashboard_id)` indexes plus a partial unique constraint on `(dashboard_id, resource_type, resource_id)` where `resource_id IS NOT NULL`. Validate choices with `EXPLAIN` on realistic data.
- **Effort / Risk** — Small / Low.
- **Impact** — Speeds core listings/access checks and enforces resource-widget uniqueness.

### 30. Put remaining domain invariants in PostgreSQL

- **What & where** — `backend/app/models/dashboard.py:25-30`; `backend/app/models/calendar.py:69-81`; `backend/app/models/list.py:41-58`; assignment persistence `backend/app/routers/lists.py:333-359`; override input `backend/app/schemas/calendar.py:97-121`
- **Problem** — Widget resource fields can be half-populated, reminder offsets and sort orders can be negative, assignments need not belong to the dashboard audience, and arbitrary timestamps can create overrides that are not recurrence instances. Direct SQL or future code can violate assumptions.
- **Proposal** — Add paired-field/type/check constraints and nonnegative ordering/reminder constraints; validate assignees against active participants. Verify occurrence membership before an atomic override upsert and cover invalid, DST, monthly/yearly, and concurrent cases.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Makes invalid states impossible or locally diagnosable.
- **Disposition** — ◐ Partially done 2026-07-16 (`8543fab`). The nonnegative-ordering slice
  landed with list/item reordering: `ck_lists_sort_order_nonneg` and
  `ck_list_items_sort_order_nonneg` CHECK constraints on `lists`/`list_items`, declared in the
  model `__table_args__` (so `create_all`-built test schemas enforce them) **and** in migration
  `a3f7c2e9d1b4`. This also closes #14's `sort_order ge=0` gap. Still open: widget-resource
  paired-field constraints, reminder-offset constraint (defensive-only — `calendar_reminders` is
  dead schema, see #41), assignee-in-audience validation, and calendar override
  occurrence-membership.

### 31. Normalize email identity and validate production security settings

- **What & where** — `backend/app/models/user.py:10-18`; exact lookups `backend/app/routers/auth.py:217,292,309,364`; settings `backend/app/config.py:5-18`; cookie security toggle `backend/app/routers/auth.py:42`
- **Problem** — PostgreSQL string uniqueness and equality are case-sensitive, allowing logical duplicate accounts and case-dependent login. `environment` accepts arbitrary strings, so a typo disables secure cookies; secret strength is not checked.
- **Proposal** — Canonicalize email and enforce `lower(email)` uniqueness or `citext`, resolving existing conflicts explicitly. Model environment as an enum and fail production startup on insufficient secret entropy, insecure frontend URL, or missing required email settings.
- **Effort / Risk** — Small-Medium / Medium due to existing data reconciliation.
- **Impact** — Prevents account ambiguity and fail-open production cookie configuration.

### 32. Expand CI into migration, contract, browser, and supply-chain gates

- **What & where** — `.github/workflows/ci.yml:12-53`; `Makefile:34-54`; `backend/pyproject.toml:21-30`; `frontend/package.json:6-17`; `.pre-commit-config.yaml:48-58`
- **Problem** — CI covers lint/types/unit tests/frontend build but not migrations, production images, Compose validation, coverage thresholds, browser E2E, accessibility, API contract drift, backend dependency audit, `deptry`, secrets, SAST, or image vulnerabilities. Current green tests missed findings 1, 4, 9, and 11.
- **Proposal** — Add staged jobs for Alembic smoke/check/upgrades, backend/frontend coverage, OpenAPI generation diff, Playwright critical journeys and responsive drag tests, axe, production Docker builds, Compose config, `deptry`, OSV/pip audit, secret scanning, CodeQL/Semgrep, Trivy/Grype, SBOMs, and signed release images.
- **Effort / Risk** — Medium-Large / Low; stage expensive jobs by PR/release cadence.
- **Impact** — Detects schema, session, packaging, accessibility, and supply-chain failures before release.

### 33. Move migrations out of application startup

- **What & where** — `backend/Dockerfile:23`; `backend/Dockerfile.prod:21`; irreversible migration example `backend/alembic/versions/q6s8u0w2y4a6_dashboard_owned_lists_and_events.py:162-163`
- **Problem** — Every API container runs migrations before serving. Long/failing migrations cause downtime, replicas can race, and rolling back an application may be incompatible with an already-applied irreversible schema.
- **Proposal** — Run an explicit one-shot migration stage with a PostgreSQL advisory lock, compatibility preflight, verified backup, and failure gate. Adopt expand/migrate/contract rules and document application/schema rollback compatibility.
- **Effort / Risk** — Medium / Medium.
- **Impact** — Makes releases predictable, scalable, and recoverable.

### 34. Publish atomic, immutable releases

- **What & where** — `deploy.sh:4-23`; `docker-compose.prod.yml:3-16`
- **Problem** — Two independent images default to mutable `latest`; a partial push can deploy mismatched frontend/backend versions, artifacts cannot be tied reliably to a commit, and rollback is ambiguous.
- **Proposal** — Build both in CI, tag with release/Git SHA, record digests, and deploy one manifest pinned to those digests only after all checks pass. Add post-deploy readiness/smoke checks and automated rollback to the prior manifest.
- **Effort / Risk** — Medium / Low.
- **Impact** — Reproducible releases and straightforward rollback.

### 35. Define and test backup/restore for self-hosters

- **What & where** — external DB configuration `docker-compose.prod.yml:13-24`; `.env.prod.example:1-3`; deployment steps `deploy.sh:29-31`; destructive migrations `backend/alembic/versions/q6s8u0w2y4a6_dashboard_owned_lists_and_events.py:157-163`
- **Problem** — The repository defines no backup, retention, encryption, restore test, or migration preflight despite irreversible and data-deleting migrations. A deployment recipe without recovery is incomplete for household data.
- **Proposal** — Automate logical/physical backups before migrations, off-host encrypted retention, and scheduled restore drills. Gate destructive migrations on a recent verified backup, row-count reconciliation, and disk-space checks.
- **Effort / Risk** — Medium / Low.
- **Impact** — Makes the self-hosted system operationally recoverable.

### 36. Harden and reproduce production containers

- **What & where** — `backend/Dockerfile.prod:1-21`; `frontend/Dockerfile.prod:1-18`; `deploy.sh:15-19`; `.github/workflows/ci.yml:45-49`; `docker-compose.prod.yml:1-27`
- **Problem** — Base images and `uv:latest` are mutable; CI uses Node 22 while production builds on Node 20; the frontend build sends the repository root without a root `.dockerignore`. Containers run as root with writable filesystems, default capabilities, no `no-new-privileges`, and no resource/PID limits.
- **Proposal** — Pin image/tool digests, align Node versions, add a restrictive root `.dockerignore`, and run dedicated non-root users. Apply read-only filesystems, controlled tmpfs, dropped capabilities, `no-new-privileges`, and tested CPU/memory/PID limits.
- **Effort / Risk** — Medium / Medium; Caddy/Python write paths must be enumerated.
- **Impact** — Reduces supply-chain variance, build-context exposure, and container compromise blast radius.

### 37. Add readiness, database lifecycle controls, and observability

- **What & where** — `backend/app/routers/health.py:1-11`; `backend/app/database.py:7-17`; `backend/app/main.py:14-40`; `docker-compose.prod.yml:5-7`
- **Problem** — Health always reports OK without PostgreSQL, the engine uses implicit pool defaults with no pre-ping/timeouts/lifespan disposal, and logging has no request IDs, structured fields, metrics, or slow-query visibility. Orchestration can route traffic to a database-dead API.
- **Proposal** — Split `/health/live` and bounded `/health/ready` (`SELECT 1` plus optional Alembic revision); configure pool size/overflow/pre-ping/recycle/connect/statement/lock timeouts and lifespan disposal. Emit structured request, error, pool, query, auth, and SSE metrics with correlation IDs.
- **Effort / Risk** — Medium / Low after load testing.
- **Impact** — Accurate deployments and enough telemetry to diagnose/tune failures.

### 38. Bound collection APIs and retained rows

- **What & where** — full collections `backend/app/routers/dashboards.py:458-464`, `backend/app/routers/lists.py:183-217`; token/event tables `backend/app/models/refresh_token.py:11-24`, `backend/app/models/activity.py:50-75`; notifications `backend/app/routers/notifications.py:31-43`
- **Problem** — Dashboard/list responses have no pagination contract, notification history is truncated without a cursor, and expired/revoked tokens plus append-only activity have no pruning lifecycle. Storage and latency grow indefinitely.
- **Proposal** — Standardize cursor envelopes (`items`, `next_cursor`) and active/archived filters; add documented retention horizons and scheduled indexed batch pruning for security tokens, notifications, and activity.
- **Effort / Risk** — Medium / Medium; frontend contracts change.
- **Impact** — Predictable API latency and bounded database growth.
- **Disposition** — ◐ Partially done 2026-07-17 (`a92bc28`). Shipped the **security-token/session half**: a scheduled,
  advisory-locked retention reaper — `backend/app/services/retention.py` (`reap_expired_auth_rows`
  pure core, `run_reaper_once` under `pg_try_advisory_xact_lock`, `reaper_loop`), wired via a new
  app `lifespan` in `main.py`, config `reaper_enabled` (default on) + `reaper_interval_hours`
  (default 6), tests `backend/tests/test_retention.py` (4, each mutation-verified sensitive). Runs at
  startup then every 6h; off in tests (lifespan does not fire under `ASGITransport`). Deletes expired
  refresh/verification/reset tokens and idle sessions whose tokens are all expired, guarded against
  early logout (`last_used_at` idle window) and against cascade-deleting reuse evidence (a session is
  pinned while any unexpired token remains). **Still open — the *should-grow* half:** collection
  pagination (dashboards/lists), a notification cursor, and an `activity_events` retention horizon —
  bound these, do not prune them.
- **Scope + design notes added 2026-07-17** (from the session-revocation work, `22c9dfd`..`4089d88`;
  the token/session half **shipped the same day** — see Disposition). These record the design the
  reaper implements and why a naive prune deletes a security feature; keep them for the still-open
  collection/activity half.
  - **Two categories, one finding — keep them separate.** *Should-grow* tables (`activity_events`
    the append-only audit log, `notifications`) are legitimate history: bound them with a retention
    horizon + pagination, never by deleting live rows. *Should-be-pruned* tables are the security
    tokens, whose rows are pure dead weight once spent or expired. The user's stated concern is the
    latter set; the token half below is what to build first if this is pulled forward.
  - **The prune set is four token tables + `sessions`, not just `refresh_tokens`.** All of
    `refresh_tokens`, `email_verification_tokens`, `password_reset_tokens`, and `sessions` are
    never pruned (`sessions` grows per login; the two single-use token tables grow per
    registration/reset — both trivial next to per-rotation `refresh_tokens`, but same profile: a
    row that is dead once `used_at`/`expires_at` passes). The single-use token tables carry no
    reuse-detection role, so the ⚠ caveat below is specific to `refresh_tokens`.
  - **`sessions` joins this finding's scope.** The new `sessions` table (one row per login) is never
    pruned either. It grows far slower than `refresh_tokens` (per login, not per rotation).
  - **Pulled forward as a small Phase 2 addendum (done).** Dead-token pruning is auth hygiene and
    self-contained, so it shipped alongside the Phase 2 auth work rather than waiting on Phases 3–6
    or the backlog. See Disposition.
  - **Was true until 2026-07-17: nothing anywhere pruned.** Before the reaper, no cron/scheduler
    existed — the only cleanup machinery was `services/shares.py::cleanup_resource_shares`, and every
    rotation added a permanent `refresh_tokens` row. The reaper (Disposition) now bounds it.
  - **Scale is modest, not urgent.** A refresh fires when a request 401s, not on a timer, so growth is
    roughly single-digit MB/year at household scale, and every lookup is by `token_hash` through a
    unique B-tree, so query cost is unaffected. This is a hygiene/policy gap, not a live problem.
  - **⚠ DO NOT prune consumed-but-unexpired tokens.** The consumed row **is** reuse detection's
    evidence: a replay is detected by finding the row and reading its `revoked_at`. Delete it and a
    detected theft silently degrades to a plain 401 with the thief's session intact. Rotation-time
    "delete the old token" is exactly this mistake.
  - **Only expired rows are inert — traced and provable.** For a token past `expires_at`, the outcome
    is identical whether its row exists or not: the atomic `UPDATE` cannot match it (`expires_at >
    now` fails) and the fall-through either finds it and rejects on `expires_at <= now`, or does not
    find it and rejects on `token is None` — both reject WITHOUT revoking the session
    (`app/services/sessions.py`). So pruning `WHERE expires_at < now()` is behaviour-preserving.
  - **Recommended approach: a scheduled reaper, matched to industry norm.** Every framework that
    solves this ships a periodic sweep, not cleanup-on-write (Django `clearsessions`/
    `flushexpiredtokens`, Laravel `auth:clear-resets`/`passport:purge`, `connect-pg-simple`'s
    interval prune, Supabase GoTrue's reaper, Keycloak). One idempotent `DELETE ... WHERE
    expires_at < now()` per token table on an interval (~6–24h), plus the guarded `sessions` sweep
    below. Delivery, matched to this app's shape (single uvicorn process — no `--workers` — and an
    alpine Postgres image with no `pg_cron`): an **in-process task in a `lifespan` handler**
    (none exists yet; APScheduler / `fastapi-utils @repeat_every` / a bare `asyncio` loop). Zero new
    infra; `pg_cron` (custom image) and a separate cron container (extra service) are both
    disproportionate at household scale.
  - **Make it multi-process-safe now with a Postgres advisory lock.** (Shipped: `run_reaper_once`
    wraps the sweep in `pg_try_advisory_xact_lock(<constant>)` and skips if not acquired — the
    transaction-scoped variant, so the lock auto-releases on commit and a crash mid-sweep cannot
    strand it.) The same code is correct at any process count — 1 uvicorn worker today, or N
    processes across a cluster later — with exactly one reaper per interval and no Redis /
    leader-election infra. The cheap forward-compatible choice, taken even though we run
    single-process today. (See the horizontal-scaling readiness note, #45, for the pieces that are
    *not* yet cluster-safe — SSE fan-out, the in-memory rate limiter, and startup migrations.)
  - **Rejected: opportunistic delete on rotation.** An earlier idea ran `DELETE ... WHERE user_id = ?
    AND expires_at < now()` on each refresh — cron-free and index-friendly, but inferior on reflection:
    it never sweeps **dormant users** (someone who stops logging in keeps their dead rows, including
    the `ip_hash`/`user_agent_hash` on `sessions` — the opposite of data-minimization), it adds write
    amplification to the latency-sensitive login path, and it gives no deterministic bound on the
    oldest row. The scheduled reaper sweeps globally and keeps cleanup off the hot path.
  - **This is data-minimization, not just disk.** `sessions` retains hashed IP and user-agent; keeping
    dead ones forever is exactly what retention-horizon norms tell you not to do. That reframes the
    urgency: trivial on storage grounds, but worth doing correctly as security hygiene.
  - **Pruning `sessions` needs a guard.** A session whose refresh token has expired may still have a
    live 15-minute access token; deleting it logs that user out early. Gate on `last_used_at` older
    than `access_token_expire_minutes`.
  - **Growth can exceed one row per rotation.** The refresh grace window deliberately lets racing tabs
    each mint a successor, so a stampede forks the chain and leaves orphaned live tokens (bounded by
    session revocation, which kills every token in the session). Retention math should not assume 1:1.

### 39. Extract application use cases from oversized routers

- **What & where** — `backend/app/routers/dashboards.py:458-1092`; duplicated audience/access flows `backend/app/routers/lists.py:40-105` and `backend/app/routers/calendar.py:38-71`; repeated commit/event/broadcast flows throughout those routers
- **Problem** — HTTP validation, authorization, persistence, activity, notification, and SSE concerns are coupled. The 1,092-line dashboard router repeats transaction/broadcast patterns, contributing to inconsistent no-op PATCH, mutation-ID, query, and delivery behavior.
- **Proposal** — Extract narrow application use cases with a unit of work that returns domain results plus staged outbox events; centralize dashboard access/audience and typed event envelopes. Keep routers as request/auth/status adapters.
- **Effort / Risk** — Large / Medium; migrate endpoint families incrementally behind characterization tests.
- **Impact** — Makes authorization and transaction behavior testable once and reduces cross-module duplication.

### 40. Simplify archive/delete UX into a recoverable lifecycle

- **What & where** — list deletion requires prior archive at `backend/app/routers/lists.py:281-308`; dashboard archive/delete prompts `frontend/src/pages/DashboardsPage.tsx:80-92`; list row actions `frontend/src/components/lists/ListSidebarRow.tsx:104-186`
- **Problem** — Lists require a two-step archive-then-delete flow, dashboards expose archive and immediate permanent delete, and hidden row/card actions make both hard to understand. The lifecycle is inconsistent across resources and relies on destructive confirmation instead of recovery.
- **Proposal** — Use one "Move to trash" action with a visible archived/trash view, restore, and retention-based purge; reserve permanent delete for the trash view. Align dashboard/list behavior and explain dependent widgets before the action.
- **Effort / Risk** — Medium / Medium; affects backend retention and UI copy.
- **Impact** — Reduces friction and accidental loss while making resource lifecycle consistent.

### 41. Split routes and remove dead frontend/backend surfaces

- **What & where** — eager page imports `frontend/src/App.tsx:5-16,53-79`; dead frontend files `frontend/src/components/calendar/CalendarEditorDurationToolbar.tsx:1-100`, `frontend/src/components/lists/CreateListCard.tsx:1-69`, `frontend/src/App.css`; dead schema/events `backend/app/models/calendar.py:69-81`, `backend/app/models/activity.py:31-34`
- **Problem** — Calendar/grid code ships on public auth routes in one 471.82 kB chunk. Unused alternative components, starter assets, `CalendarReminder`, and membership event variants confuse ownership and preserve feature surfaces with no execution path.
- **Proposal** — Lazy-load route modules with Suspense and preload authenticated destinations after login. Remove dead files/types/tables, or explicitly complete reminder CRUD/scheduling/delivery before retaining that schema. Verify bundles with a size budget.
- **Effort / Risk** — Small-Medium / Low for code splitting/cleanup; reminder implementation would be Large.
- **Impact** — Faster startup and less maintenance ambiguity.

### 42. Clean up documentation, transient UI state, and small correctness traps

- **What & where** — obsolete group/invite claims `README.md:9-15` and `CONTEXT.md:27-67`; stale plan model `PLAN.md:11-75`; persisted mobile overlay `frontend/src/stores/ui.ts:12-22`; confirm resolver `frontend/src/stores/confirm.ts:12-31`; raw bearer-link logging `backend/app/services/email.py:20-37`
- **Problem** — Documentation describes removed groups, invites, and visibility rather than dashboard-owned sharing. UI persistence can reopen the mobile drawer after reload; a second global confirmation overwrites the first unresolved promise; debug email fallback logs raw verification/reset bearer URLs.
- **Proposal** — Rewrite architecture/user docs around the implemented visibility model; persist only `sidebarCollapsed`; queue or explicitly reject concurrent confirms and resolve them on unmount/logout; log token-free local email guidance rather than raw bearer URLs. Also replace mutable-looking Pydantic collection defaults with factories and remove unused async/parameters such as `backend/app/routers/dashboards.py:267-274`.
- **Effort / Risk** — Small / Low.
- **Impact** — Improves onboarding and removes several low-cost state, security, and maintenance hazards.
- **Disposition** — ◐ Partially done 2026-07-16 (`3b45f1e`, `9c7f148`): documentation sub-items (README/CONTEXT.md group claims, stale PLAN.md) fixed by the docs overhaul. Still open: `ui.ts` persisted mobile overlay, `confirm.ts` concurrent-confirm overwrite, `email.py` bearer-URL logging, unused async/params; Pydantic-defaults sub-item downgraded to cosmetic (v2 deep-copies defaults).

## Top 10 highest-leverage

| Rank | Improvement | Primary gain | Effort | Risk |
|---:|---|---|---|---|
| 1 | Reset dashboard state on auth changes | Cross-account privacy and correctness | Medium | Medium |
| 2 | Fix dashboard deletion ownership/cascades | Data lifecycle integrity | Medium | Medium |
| 3 | Disallow verification-token session replay | Authentication security | Small | Low |
| 4 | Check DELETE response status | Client/server correctness | Small | Low |
| 5 | Reject empty PATCH mutations | Authorization and audit integrity | Small | Low |
| 6 | Atomically consume refresh/reset tokens | Session security under concurrency | Medium | Medium |
| 7 | Revoke sessions on password change | Stolen-session containment | Medium | Medium |
| 8 | Expire and correctly close SSE streams | Authorization and resource safety | Medium | Medium |
| 9 | Separate responsive and canonical layouts | Prevent user layout loss | Medium | Medium |
| 10 | Standardize mutation failure contracts | Honest, recoverable UX | Medium | Medium |

---

## New findings — 2026-07-16 (design pass, session revocation spec)

Found while mapping the auth surface for Phase 2 spec 1, not by the 2026-07-11 review. Numbering
continues from #42.

### 43. Remove the login user-enumeration timing oracle

- **What & where** — `backend/app/routers/auth.py:371`; `backend/app/auth/hashing.py:4-16`
- **Problem** — Login short-circuits on an unknown email (`if not user or not verify_password(...)`),
  so a nonexistent account answers in ~0ms while a real one pays a full Argon2 verify (~50-100ms).
  The response bodies are identical, but the timing is not — the endpoint reliably discloses whether
  an email has an account. Argon2's deliberate cost is what makes the gap wide enough to measure
  remotely.
- **Proposal** — Verify against a fixed dummy hash on the miss path so both branches pay the same
  cost. Fix alongside **#13** (which moves hashing to a thread pool and re-touches these exact
  lines); doing it separately means two specs editing one code path.
- **Effort / Risk** — Small / Low.
- **Impact** — Closes account enumeration on the one endpoint that cannot be rate-limited into
  uselessness.
- **Disposition** — ◻ Open. Assigned to Phase 2 spec 3 (#13).

### 44. `POST /auth/refresh` has no CSRF guard and no rate limit

- **What & where** — `backend/app/routers/auth.py:381`
- **Problem** — The only unauthenticated POST in the auth router with neither
  `_csrf: None = Depends(require_csrf)` nor a `@limiter.limit` decorator. `backend/CLAUDE.md` states
  every non-GET route must add the CSRF dependency; `logout`, `profile`, `password` and
  `preferences` all do. A cross-site page can therefore force a token rotation, and the endpoint is
  unmetered.
- **Proposal** — Add both, matching the sibling routes.
- **Effort / Risk** — Small / Low.
- **Impact** — Restores the router's own invariant on the one route that skips it.
- **Disposition** — ✅ Done 2026-07-17 (`dfd8234` backend, `f182ea2` frontend). Added
  `@limiter.limit("30/minute")` and a CSRF guard. `require_csrf` could not be reused — it depends
  on `get_current_user`, and `/refresh` exists precisely because the access token expired — so
  `require_csrf_without_session` compares the double-submit pair directly and `require_csrf`
  delegates to it. **The backend guard shipped with a matching frontend fix in the same batch,
  and had to:** `tryRefresh` sent no header, so the guard alone would have 403'd every refresh and
  logged out every user at the 15-minute access-token expiry. Rate-limit behaviour is not tested
  (no `429` assertion pattern exists in the suite, and IP-bucketing under the test transport is
  unverified); the CSRF half is. Follow-up logged: a 429 on `/refresh` currently reads as logout,
  and the limiter buckets per-IP so a household behind one NAT shares the budget.

### 45. Horizontal-scaling / multi-process readiness

- **Logged 2026-07-17** (architecture note, not from the 2026-07-11 review pass). Surfaced while
  designing the #38 token reaper — captured here so the cluster-readiness picture lives in one place.
- **What & where** — SSE manager `backend/app/sse/manager.py:104` (`manager = SseManager()`, in-memory
  `_clients`); rate limiter `backend/app/limiter.py:4` (`Limiter(key_func=get_remote_address)`, no
  `storage_uri` → in-memory); startup migrations `backend/Dockerfile.prod:21` (`alembic upgrade head
  && exec uvicorn`); connection pool sizing (per-process × node count).
- **Context — the hard part is already done.** The session-revocation work moved auth *authority* out
  of process memory into Postgres (sessions, tokens, revocation), and the revocation guarantee is
  explicitly worker-agnostic (30s periodic revalidation is the guarantee; the in-process stream drop
  is only a latency optimisation). So auth is already cluster-safe; what remains is delivery,
  metering, and orchestration. Prod today runs a **single** uvicorn process (no `--workers`), so none
  of this bites yet — this is forward-looking, currently YAGNI.
- **Problem (ranked by blast radius under multi-process / multi-node):**
  1. **SSE fan-out is process-local.** `broadcast()` only reaches clients connected to the same
     process; a mutation on node A cannot push to a user's stream on node B — silent staleness. The
     real blocker. Fix: a pub/sub backplane (Redis pub/sub or Postgres `LISTEN/NOTIFY`) so a broadcast
     on any node fans out to all, each delivering to its local clients (Socket.IO Redis adapter /
     Django Channels / ActionCable pattern).
  2. **Rate limits are per-process.** In-memory slowapi buckets mean effective limit = N× intended
     across workers. Fix: `storage_uri="redis://…"`.
  3. **Startup migrations race.** N containers each running `alembic upgrade head` on boot contend on
     the version table. Fix: run migrations as a separate init job/step, not in every app
     entrypoint.
  4. **Connection pool multiplies** into Postgres's ceiling (capacity, not correctness). Fix:
     PgBouncer in front — transaction mode requires disabling async prepared-statement caching.
- **Already forward-compatible:** the #38 reaper, if built with a `pg_try_advisory_lock` guard, is
  correct at any process count with no extra infra — do it that way regardless of when clustering
  lands. See #38.
- **Effort / Risk** — Large / Medium (backplane is a real project). **Deferred** — no scaling need at
  household scale; recorded so the four pieces are known before anyone reaches for a second replica.
