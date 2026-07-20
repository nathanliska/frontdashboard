# FrontDashboard — Current State

> **This is a CURRENT-STATE doc, not a changelog.** When a feature lands, fold its *current
> behavior* into the right section below; don't append dated entries. Remove what no longer
> exists. Live remediation status lives in `docs/references/review-findings.md`.

_Last updated: 2026-07-19_

## What's built

**Auth & account**
- Registration → email verification (required before login) → JWT session in HttpOnly cookies
  with CSRF double-submit; single-use rotating refresh tokens (7d) + 15-min access tokens.
- **Email identity is case-insensitive**: addresses are normalized (trim + lowercase) at the API
  boundary and a `lower(email)` functional unique index is the DB guarantee, so casing can't create
  duplicate accounts or block login. Display names are bounded (trimmed, non-empty, ≤100 chars).
- **Sessions are first-class**: one `sessions` row per login, stable across refresh rotation. The
  access JWT carries its `sid` and every request checks the session is live, so revocation is
  immediate. Password change revokes every *other* session and keeps yours; reset and logout
  revoke accordingly. Refresh rotation consumes atomically with a 10s grace window so racing tabs
  (which share one cookie and expire together) both survive; a replay after that window is treated
  as reuse and revokes the session. `/auth/refresh` is CSRF-guarded and rate-limited.
- Password reset via email; authenticated password change and profile rename (both re-issue the
  access cookie). Rate limits on all auth endpoints.
- **Password hashing is Argon2, run off the event loop**: `hash_password`/`verify_password` execute
  in a worker thread via `anyio.to_thread.run_sync` under a shared, bounded capacity limiter
  (`argon2_max_concurrency`, default 4), so an auth burst can't stall the event loop or exhaust
  memory. **Login is enumeration-safe**: it always pays exactly one Argon2 verify (against a fixed
  dummy hash when the email is unknown) and returns an identical 401 whether the account is missing
  or the password is wrong — no timing side-channel.
- Emails send via Resend in background tasks; without an API key the sender logs the link
  (how you get tokens locally). HTML templates exist for both flows.
- Profile page: display name, password change, home-dashboard preference.
- **Client state resets at every auth boundary** (login, logout, email verification, unauthenticated
  startup): notifications, resource caches, and the dashboard store (fields, in-flight request
  machinery, pending mutations) are all cleared. A shared session-generation counter guards every
  async write in the **dashboard, auth, and notifications** stores — each captures the generation at
  entry and drops its post-await write if a boundary crossed — so a prior account's in-flight response
  can't repopulate the next account's state (dashboards, `user`, or notifications) in the same tab.
  Logout tears down the session view and SSE stream before its network round-trip.

**Dashboards & widgets**
- Multiple dashboards per user; default "My Dashboard" created on registration. Listing page
  with favorites, create modal, archive (badge + section + editor banner), hard delete (also
  removes owned lists/items/events/widgets/shares).
- Editor: react-grid-layout drag/resize, saves with optimistic version → 409 conflict banner +
  reload resolution; settings modal (rename/archive/share).
- **The persisted layout is canonical; the mobile view is a derived projection.** Below 640px the
  grid renders a computed one-column stack, and layout events are ignored there (and on read-only
  dashboards), so the projection can never overwrite the desktop arrangement. Editable mobile
  layouts would need their own per-breakpoint persisted layout — deliberately not built.
- **Layout saves are serialized and coalesced**: one PUT in flight at a time plus one latest-pending
  layout, each send re-reading the version the previous save returned. Rapid drag/resize therefore
  can't conflict with itself or install an older layout; a 409 means a *real* other-editor conflict.
- **Dashboard mutations share one success/failure contract**: store actions never throw —
  value-producers resolve `T | null`, void ones resolve `boolean`, and the store owns the error
  toast. Dialogs close, inputs clear, and navigation happen only on a truthy result, so a failed
  create/rename/widget-add/share-add keeps the user's input instead of discarding it.
- Widget types: **list** (bind existing or auto-create), **clock**, **calendar**, **agenda**
  (today/overdue/upcoming). Add-widget wizard picks type → resource where applicable.

**Sharing** (groups feature was removed — per-resource shares replaced it)
- Dashboards are shared directly with users (search by name/email) as viewer/editor; owner =
  creator. Lists and calendar events inherit access from the dashboard that binds them; their
  `/shares` endpoints are deliberate 409 stubs. Share/unshare and archiving notify affected
  users and clean up their preferences.

**Lists**
- Master/detail lists UI with nested routes + mobile slide nav; items support check, due date,
  priority, category, assignee, manual sort order. Lists must be archived before delete (409
  otherwise); delete cleans up bound widgets and shares. Soft delete throughout.
- **Drag-and-drop reorder** (dnd-kit) of items within a list and of lists in the sidebar, via
  drag handles with keyboard support. Order persists through two transactional endpoints
  (`PUT /lists/{id}/items/order`, `PUT /lists/order`) that renumber `sort_order` to `0..n-1`
  under a row lock and require the submitted id set to match exactly (409 otherwise); DB CHECK
  constraints keep `sort_order` nonnegative. Checked items stay in place — manual order is the
  only order. New lists append last.
- The sidebar has an **Active/Archived** selector: Active is the default and is reorderable;
  archived lists are viewable but not reorderable (the server renumbers only non-archived
  lists, so the submitted set must equal that set). The dashboard `ListWidget` is deliberately
  not reorderable — it sits inside react-grid-layout, whose own drag would conflict.
- The hot list SSE events — reorder, plus item check/update — carry the new state (id order, or
  the changed fields' values), so other clients patch their caches in place with no follow-up
  GET. A refetch happens only if the payload is absent (older events) or the patched result
  diverges from cache. Rarer events (create/delete/archive) deliberately keep
  invalidate-and-refetch: self-healing is worth more than bytes on cold paths. See
  `docs/shipped/sse-hardening-design.md`.

**Calendar**
- Day/week/month views; full event editor (mobile-optimized) with weekly recurrence, duration
  toolbar, all-day, timezones; per-occurrence overrides and cancellation. Occurrence expansion
  over a required window (max 366 days).
- **Day-dependent views refresh at local midnight.** A shared `useLocalDay()` hook re-renders at the
  next local midnight (DST-safe) and on tab wake (visibility/focus); the calendar widget and page
  re-derive "today" from it, and the agenda widget background-refetches on a day rollover — so an
  always-on wall display never shows yesterday's agenda/highlights after midnight.

**Notifications & activity**
- In-app inbox (unread-first, mark one/all read) with live SSE push; activity feed of the
  caller's own events, keyset-paginated, hiding noisy event types by default.

**Real-time (SSE)**
- One multiplexed `EventSource('/api/sse')` per user; in-memory manager with bounded queues,
  `connected` priming event, `resync` on reconnect with `Last-Event-ID`. Frontend routes
  events to Zustand stores / scoped-query resource caches with client-mutation-id echo
  suppression.
- A client whose queue overflows is evicted with a closed sentinel, so its stream ends with a
  `resync` and reconnects — rather than staying connected and silently deaf.
- A stream rejected with an HTTP error status (`readyState === CLOSED`, which `EventSource`
  never retries) refreshes the session and reconnects on exponential backoff (1s → 30s cap,
  indefinitely), redirecting to `/login` only if the refresh itself fails. Because a fresh
  `EventSource` sends no `Last-Event-ID`, that path asks for the resync itself; the browser's
  own auto-retry of a network drop is left alone and resyncs via the header as before.
- Streams revalidate their session every 30s and end when it is revoked; revocation also drops
  them in-process immediately (the drop is a latency optimisation, not the guarantee — the periodic
  check is worker-agnostic and holds without it). Closes #8's authorization half: a revoked session
  stops streaming within 30s and stops being accepted on requests immediately.

**Infra / tooling**
- Docker Compose dev + prod, Caddy in prod (behind a Cloudflare Tunnel), named volumes, health checks.
- **Production config fails fast**: `ENVIRONMENT` is a **required** validated enum (a prod deploy that
  forgets it won't boot rather than silently running insecure), and production startup aborts on a
  weak/placeholder `secret_key` (< 32 chars), a missing `resend_api_key`, or an undeliverable
  `email_from`. Startup logs the active environment and cookie posture (`INFO` prod / `WARNING`
  otherwise).
- **Rate limits are per real client IP**: the limiter keys on Cloudflare's `CF-Connecting-IP` (the
  origin is a non-public Cloudflare Tunnel, so it's authoritative), falling back to the peer address
  in dev — so auth limits isolate per client instead of collapsing into the shared proxy IP. Buckets
  are in-memory/per-process, correct for the current single worker (shared store tracked in #45).
- CI: lint (Ruff/Biome), dead-code and dependency gates (knip, deptry), workflow linting
  (actionlint), tests (pytest, Vitest), `ty` type check, frontend build, and a production frontend
  image build. Backend tests build their schema with `alembic upgrade head`, so **migrations run on
  every CI job** and `test_migrations.py` fails on ORM↔migration drift; `make test-unit` runs the
  Docker-free subset. Pre-commit hooks incl. Conventional Commit enforcement. Dependabot
  grouped/monthly.

## In flight

- **Design-review remediation** (see the live tracker in
  `docs/references/review-findings.md`): Phase 1 (security quick wins #3/#4/#5) shipped
  2026-07-12. SSE hardening shipped 2026-07-16, closing #8's eviction half. **Phase 2
  (auth/session hardening) is fully shipped 2026-07-17** across four specs: session revocation
  (#6/#7/#8/#44), frontend auth-boundary reset (#1), Argon2 off the event loop + login timing oracle
  (#13/#43), and email normalization + production config validation (#31, plus the #14 display-name
  slice). A follow-up security review (2026-07-17) is fully remediated: all High/Medium closed, with
  register enumeration accepted as a deliberate household-scale risk and only #52 (SSE resync
  griefing, Low) left open. **Phase 3 (dashboard correctness) is in progress**, sliced by mechanism:
  **Phase 3 (dashboard correctness) is complete** (2026-07-20): slice A (#2, deletion integrity),
  slice B (#9 + #11, layout save correctness), slice C (#10, mutation contracts), and slice D (#12,
  midnight invalidation), closed by a clean batched whole-branch review (one drain-flag race fixed).
  **Phases 4–6 and the unscheduled backlog remain** (see the rollout table in
  `docs/references/review-findings.md`).

## Deliberately deferred / known dead code

- Review-findings backlog phases 3–6 + unscheduled triage bucket — tracked in the rollout
  table, not here.
- `CalendarReminder` model + table exist with **no** router/service usage (vestigial; slated
  for a decision when calendar work resumes).
- `EventType.membership_*` values are vestiges of the removed groups feature.
- Share principal types other than `user`, and share roles beyond viewer/editor, are
  intentionally not built.
