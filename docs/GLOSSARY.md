# Glossary

The canonical vocabulary for FrontDashboard — terms with a project-specific meaning. Organised into
four sections by **who uses the word**: **UI** (visible surfaces), **Product** (user-facing
concepts), **Access** (sharing/roles), **Backend** (contributor jargon). Siblings of the
[FDRs](fdr/INDEX.md) and [ADRs](adr/INDEX.md).

This is a reference, not a tutorial: entries define what a word *means* and link to the FDR/ADR that
owns the concept. Standard tech terms with no FrontDashboard-specific meaning (PostgreSQL, JWT, SSE
in the abstract) are not defined here.

## UI

**Dashboard** — A user's top-level surface: a grid of widgets they arrange. A user has several. See [FDR-002](fdr/FDR-002-dashboards-and-layout.md).

**Widget** — A tile on a dashboard grid. Four types: list, clock, calendar, agenda. See [FDR-003](fdr/FDR-003-widgets.md).

**List Widget** — A widget showing a list. Deliberately not drag-reorderable (its drag would fight the grid's). See [FDR-003](fdr/FDR-003-widgets.md).

**Agenda Widget** — A widget showing today / overdue / upcoming items; background-refetches on a day rollover. See [FDR-003](fdr/FDR-003-widgets.md).

**Editor** *(dashboard editor)* — The drag/resize layout-editing mode of a dashboard. Distinct from the *editor role* under Access.

**Listing page** — The page showing all of a user's dashboards, with favorites, create, and a Trash view.

**Master/detail (Lists UI)** — The lists layout: a sidebar of lists (master) and a pane of items (detail), with mobile slide navigation. See [FDR-005](fdr/FDR-005-lists.md).

**Conflict banner** — The banner shown when a layout save hits a version conflict (409); resolved by reloading. See [ADR-008](adr/ADR-008-layout-version-occ.md).

## Product

**Home dashboard** — The dashboard a user lands on, set as a profile preference.

**Favorite** — A user-flagged dashboard, surfaced on the listing page.

**Trash** — The one "put away" state, for dashboards, lists and calendar events alike: delete stamps `deleted_at`, the row disappears from every listing and access path, and it stays restorable — from its trash view, or from an Undo on the deletion toast — until purged on demand or by the reaper 30 days later. Replaced the separate **Archive** flag (removed 2026-07-27) — two overlapping hide-this states with different promises was one too many. See [ADR-007](adr/ADR-007-soft-delete-boundary.md).

**List** — A checklist/task list of items. See [FDR-005](fdr/FDR-005-lists.md).

**List Item** — An entry in a list, with optional due date, priority, category, assignee, and a manual sort order.

**Manual order** — The only *stored* ordering for list items: user-set, new items append last. The checked pile re-draws it but never rewrites it. See [FDR-005](fdr/FDR-005-lists.md).

**Checked pile** — The collapsible "Checked (N)" section a list draws its checked items into, keeping the manual order rather than imposing one of its own. Display-only, so unchecking returns an item to its remembered place; per-device toggle reverts to in-place rendering. The add box dedupes against it: re-adding a checked item's name unchecks the row instead of duplicating it. See [FDR-005](fdr/FDR-005-lists.md).

**Calendar Event** — A household calendar entry, possibly weekly-recurring. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Occurrence** — A single materialized instance of a recurring event, within a bounded expansion window (max 366 days). Can be individually overridden or cancelled. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Override / Cancellation** — A per-occurrence edit or removal that doesn't detach the series. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Notification** — An in-app inbox message about something affecting the user (a share, an access change). See [FDR-007](fdr/FDR-007-notifications-and-activity.md).

**Activity feed** — A keyset-paginated, self-scoped log of the caller's own actions, filterable by category or event type; nothing is withheld, and repetitive churn collapses into one counted row. See [FDR-007](fdr/FDR-007-notifications-and-activity.md).

## Access

**Member** — Anyone with access to a dashboard: the owner plus every user holding a share row — the same set SSE fan-out addresses. `GET /dashboards/{id}/members` lists them, owner first, readable by any member. See [FDR-004](fdr/FDR-004-sharing-and-access.md).

**Participant** — A member named on a calendar event as who it is *about*. A visual label only: grants no access, sends no notification, and survives the member losing dashboard access. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Owner** — The creator of a resource. Stored as the **absence** of a share row, but resolved as a named role: `effective_role` returns `EffectiveRole.owner`. Full control including delete and share. See [FDR-004](fdr/FDR-004-sharing-and-access.md).

**Editor** *(role)* — A shared user who can edit the resource and its children.

**Viewer** — A shared user with read-only access. The client emits no layout writes for viewers.

**ResourceShare** — The row granting a user access to a resource (`resource_type`, `resource_id`, `principal_type`, `principal_id`, `role`, `granted_by`). The unit of sharing after groups were removed. See [ADR-001](adr/ADR-001-per-resource-sharing.md).

**Inherited access** — Lists and calendar events derive their access from the dashboard whose widget binds them; they have no independent sharing. Their `/shares` endpoints are 409 stubs. See [FDR-004](fdr/FDR-004-sharing-and-access.md).

**Principal** — The subject of a share. `PrincipalType` is currently only `user`.

## Backend

**Reaper** — The scheduled background task that removes rows nothing can act on any more
(`services/retention.py`, started from the app lifespan, every `reaper_interval_hours`). It runs
under a Postgres transaction-scoped advisory lock, so every worker may schedule it and exactly one
executes per tick. Referenced throughout as "the retention reaper".

**Sweep** — One pass of the reaper over one category, each its own function: the **auth-row sweep**
(expired verification/reset tokens and invites, plus sessions past either of their two clocks), the
**history sweep** (`activity_events` and `notifications`), the **trash sweep**, and the
**abandoned-signup sweep**. All four share a single transaction — one failing sweep rolls back the
whole tick.

**Quota** — A ceiling on how many rows one creator may hold, checked on create and never on read,
edit or delete (`services/quota.py`, [ADR-020](adr/ADR-020-resource-quotas.md)). Counts every row
not yet purged, trash included, because a trashed row still occupies storage until the reaper takes
it. Distinct from a **rate limit**, which bounds writes per minute rather than the total.

**Horizon** — The age past which a sweep acts, always a `*_retention_days` setting: 30 days for
trash, 90 for history, 30 for unverified signups. "Past the horizon" means overdue for removal, so
a non-zero count of it is a sign the reaper has stopped rather than that the data is wrong.

**Purge** — The destructive half of the trash lifecycle: deleting a trashed row and its cascade for
real, as opposed to the `deleted_at` stamp that put it there. Done on demand from the trash, or by
the reaper at the retention horizon. See [ADR-007](adr/ADR-007-soft-delete-boundary.md).

**Soft delete** — Marking a row deleted via `deleted_at` and filtering it in every query, rather than removing it. Carried by `User`, `Dashboard`, `List` and `CalendarEvent`; list items and widgets are removed outright, because a tombstone earns its cost only where reconstructing the row by hand would be a real loss. Every tombstone has a reachable way to clear it — restore, purge, or the reaper at 30 days. See [ADR-007](adr/ADR-007-soft-delete-boundary.md).

**Layout version** — The `dashboard.version` integer used for optimistic concurrency on layout saves; a client/server mismatch is a 409. See [ADR-008](adr/ADR-008-layout-version-occ.md).

**Serialize-and-coalesce** — The client rule that keeps one layout PUT in flight plus one latest-pending layout, so rapid drag/resize can't self-conflict. See [ADR-008](adr/ADR-008-layout-version-occ.md).

**Canonical layout / stacked projection** — The persisted multi-column layout is canonical; the single-column view a narrow board falls back to is a read-only derived projection that never writes back. It triggers on width, not on device — a split-screen window stacks like a phone does. See [ADR-009](adr/ADR-009-canonical-layout-mobile-projection.md).

**First-class session** — One `sessions` row per login, and the whole credential: the `session` cookie holds an opaque token whose SHA-256 is the row, resolved on every request so revocation is immediate. There is no access or refresh token beside it. See [ADR-003](adr/ADR-003-first-class-sessions.md).

**Idle / absolute window** — The two clocks bounding a session, both enforced server-side. **Idle** (`last_used_at`, 7d) slides as the session is used; **absolute** (`expires_at`, 30d) is fixed at login and never extends, so an actively used session cannot live forever. See [ADR-003](adr/ADR-003-first-class-sessions.md).

**Session-generation counter** — A shared client counter captured at the start of every async store write; a write whose generation has since changed (an auth boundary crossed) is dropped, preventing cross-account leakage. See [ADR-012](adr/ADR-012-session-generation-guard.md).

**CSRF double-submit** — The pattern where a readable CSRF cookie's value is echoed in a request header and compared server-side; enforced per-route via `require_csrf`, together with the Origin check. See [ADR-002](adr/ADR-002-jwt-httponly-cookies-csrf.md).

**Origin check** — The second half of `require_csrf`: a state-changing request whose `Origin` header is not an allowed origin is refused, whatever its cookies say. `Origin` cannot be set by script, and unlike the double-submit pair it holds no state that can drift. Absent `Origin` is not a rejection — the token pair still applies. See [ADR-002](adr/ADR-002-jwt-httponly-cookies-csrf.md).

**Enumeration-safe login** — Login always does exactly one Argon2 verify (dummy hash for unknown emails) and returns an identical 401, closing the account-existence oracle. See [ADR-011](adr/ADR-011-enumeration-safe-login.md).

**Argon2 limiter** — The bounded capacity limiter (`argon2_max_concurrency`) under which password hashing runs off the event loop. See [ADR-010](adr/ADR-010-argon2-off-event-loop.md).

**scopedQuery** — The frontend `useSyncExternalStore` cache (keyed by scope) backing list/calendar/agenda data, via `useQuery` / `invalidateWhere` / `updateWhere`. List/calendar data lives here, not in a Zustand store. See [ADR-005](adr/ADR-005-two-layer-client-state.md).

**Zustand store** — Where singular app/session state lives (`auth`, `dashboards`, `notifications`, `toast`, `confirm`, `ui`). One of the two client state layers. See [ADR-005](adr/ADR-005-two-layer-client-state.md).

**origin client id / echo suppression** — Every mutation carries the tab's per-load `X-Client-Id`; the SSE payload echoes it back as `origin_client_id`, and the issuing tab skips frames carrying its own stamp — its mutation response already applied the change. A pure comparison, stamped centrally in `apiFetch`. See [ADR-006](adr/ADR-006-rest-fetch-sse-patch.md), [FDR-008](fdr/FDR-008-realtime-sse.md).

**Hot / cold events** — Hot SSE events (reorder, item check/update) carry new state for in-place patching; cold events (create/delete) invalidate-and-refetch. See [ADR-006](adr/ADR-006-rest-fetch-sse-patch.md).

**Build-before-commit / broadcast-after-commit** — The SSE write choreography: construct the event dict before the DB commit (ORM live), broadcast after (subscribers see only committed state). See [ADR-015](adr/ADR-015-sse-write-choreography.md).

**Broadcast audience** — The set an SSE event goes to: `{dashboard.user_id} ∪ share principal_ids`. Miss a principal and their tab goes stale. See [ADR-015](adr/ADR-015-sse-write-choreography.md).

**Resync** — The catch-up an SSE client performs when it may have missed events: a refetch of every cache it holds. Three things ask for one — the server, when the log has moved past the client's mark; the client itself, when it holds no mark; and the fan-out reader, once on recovery, for every stream on its own worker. See [FDR-008](fdr/FDR-008-realtime-sse.md).

**Mark (high-water mark)** — The highest `activity_events.event_id` a tab has been sent, primed by the `connected` frame and handed back as `?last_event_id=` on reconnect. What lets a reconnect prove it missed nothing instead of assuming it did. See [FDR-008](fdr/FDR-008-realtime-sse.md).

**Changed fields** — What a `dashboard.updated` frame says changed, drawn from the closed `ChangedField` vocabulary (`layout`, `widgets`, `name`, `restored`, `shares`) and read by clients to decide what to refetch. Two facts decide every answer: whether the client can apply the change itself, and whether the `dashboards` row moved — `widgets` alone is the case where the first is true and the second is false. Order is never significant. See [FDR-008 §10](fdr/FDR-008-realtime-sse.md).

**Backplane** — The Valkey stream that carries an SSE frame from the worker that produced it to the others, so a dashboard shared between two people reaches both when they are served by different replicas. A stream rather than pub/sub, because pub/sub loses whatever is published while a subscriber is away and says nothing. See [ADR-004](adr/ADR-004-sse-over-websocket.md).

**Fan-out reader** — The per-worker task consuming that stream. It skips frames its own worker published (already delivered locally), resumes from the last id it saw, and on recovery tells its local clients to resync — once per outage, not once per retry. See [ADR-004](adr/ADR-004-sse-over-websocket.md).

**Degraded (shared state)** — Serving traffic while a guarantee is gone: rate limits enforced per process instead of per deployment, or a worker missing other workers' frames. Neither fails a request, so each carries a gauge — `rate_limit_store_degraded`, `sse_fanout_degraded` — because nothing else distinguishes it from healthy. See [ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md).

**Overflow sentinel** — The marker that replaces an overflowing SSE client's backlog. The stream stays open and turns it into a single in-place resync; until that is delivered, further frames are dropped as covered by the refetch it orders. See [ADR-004](adr/ADR-004-sse-over-websocket.md).

**useLocalDay** — The shared hook that ticks at the next local midnight (DST-safe) and on tab wake, so day-dependent views don't stick on yesterday on an always-on display. `useLocalToday()` is the same tick as a local-midnight `Date` whose identity only changes with the day, for callers that put "today" in a dependency array. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**CF-Connecting-IP** — The Cloudflare-set real-client-IP header the rate limiter keys on; authoritative because the origin is reachable only through the Cloudflare Tunnel. See [ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md).

**log_event / stage_notification** — Backend helpers that only `db.add` (activity events / notifications); the mutating route owns the single commit, keeping them atomic with the mutation. See [ADR-015](adr/ADR-015-sse-write-choreography.md).
