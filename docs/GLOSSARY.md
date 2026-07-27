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

**Trash** — The one "put away" state, for dashboards and lists alike: delete stamps `deleted_at`, the row disappears from every listing and access path, and it stays restorable until the reaper purges it 30 days later. Replaced the separate **Archive** flag (removed 2026-07-27) — two overlapping hide-this states with different promises was one too many. See [ADR-007](adr/ADR-007-soft-delete-boundary.md).

**List** — A checklist/task list of items. See [FDR-005](fdr/FDR-005-lists.md).

**List Item** — An entry in a list, with optional due date, priority, category, assignee, and a manual sort order.

**Manual order** — The only ordering for list items: user-set, checked items stay in place, new items append last. See [FDR-005](fdr/FDR-005-lists.md).

**Calendar Event** — A household calendar entry, possibly weekly-recurring. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Occurrence** — A single materialized instance of a recurring event, within a bounded expansion window (max 366 days). Can be individually overridden or cancelled. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Override / Cancellation** — A per-occurrence edit or removal that doesn't detach the series. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**Notification** — An in-app inbox message about something affecting the user (a share, an access change). See [FDR-007](fdr/FDR-007-notifications-and-activity.md).

**Activity feed** — A keyset-paginated, self-scoped log of the caller's own actions, noisy types hidden by default. See [FDR-007](fdr/FDR-007-notifications-and-activity.md).

## Access

**Owner** — The creator of a resource. Represented as the **absence** of a share row, so `effective_role` returns `None` — never write `if role:`. Full control including delete and share. See [FDR-004](fdr/FDR-004-sharing-and-access.md).

**Editor** *(role)* — A shared user who can edit the resource and its children.

**Viewer** — A shared user with read-only access. The client emits no layout writes for viewers.

**ResourceShare** — The row granting a user access to a resource (`resource_type`, `resource_id`, `principal_type`, `principal_id`, `role`, `granted_by`). The unit of sharing after groups were removed. See [ADR-001](adr/ADR-001-per-resource-sharing.md).

**Inherited access** — Lists and calendar events derive their access from the dashboard whose widget binds them; they have no independent sharing. Their `/shares` endpoints are 409 stubs. See [FDR-004](fdr/FDR-004-sharing-and-access.md).

**Principal** — The subject of a share. `PrincipalType` is currently only `user`.

## Backend

**Soft delete** — Marking a row deleted via `deleted_at` (on `User`/`List`/`ListItem`/`CalendarEvent`, and since #40 on `Dashboard`, where it means "in the trash") and filtering it in every query, rather than removing it. Widgets are hard-deleted; the retention reaper purges trashed dashboards and lingering soft-deleted content after 30 days. See [ADR-007](adr/ADR-007-soft-delete-boundary.md).

**Layout version** — The `dashboard.version` integer used for optimistic concurrency on layout saves; a client/server mismatch is a 409. See [ADR-008](adr/ADR-008-layout-version-occ.md).

**Serialize-and-coalesce** — The client rule that keeps one layout PUT in flight plus one latest-pending layout, so rapid drag/resize can't self-conflict. See [ADR-008](adr/ADR-008-layout-version-occ.md).

**Canonical layout / mobile projection** — The persisted desktop layout is canonical; the mobile single-column view is a read-only derived projection that never writes back. See [ADR-009](adr/ADR-009-canonical-layout-mobile-projection.md).

**First-class session** — One `sessions` row per login, its `sid` in the access JWT, checked every request so revocation is immediate. See [ADR-003](adr/ADR-003-first-class-sessions.md).

**Grace window** — The 10-second window in which a rotated refresh token is still accepted, so racing tabs both survive; replay after it is treated as reuse. See [ADR-003](adr/ADR-003-first-class-sessions.md).

**Session-generation counter** — A shared client counter captured at the start of every async store write; a write whose generation has since changed (an auth boundary crossed) is dropped, preventing cross-account leakage. See [ADR-012](adr/ADR-012-session-generation-guard.md).

**CSRF double-submit** — The pattern where a readable CSRF cookie's value is echoed in a request header and compared server-side; enforced per-route via `require_csrf`. See [ADR-002](adr/ADR-002-jwt-httponly-cookies-csrf.md).

**Enumeration-safe login** — Login always does exactly one Argon2 verify (dummy hash for unknown emails) and returns an identical 401, closing the account-existence oracle. See [ADR-011](adr/ADR-011-enumeration-safe-login.md).

**Argon2 limiter** — The bounded capacity limiter (`argon2_max_concurrency`) under which password hashing runs off the event loop. See [ADR-010](adr/ADR-010-argon2-off-event-loop.md).

**scopedQuery** — The frontend `useSyncExternalStore` cache (keyed by scope) backing list/calendar/agenda data, via `useQuery` / `invalidateWhere` / `updateWhere`. List/calendar data lives here, not in a Zustand store. See [ADR-005](adr/ADR-005-two-layer-client-state.md).

**Zustand store** — Where singular app/session state lives (`auth`, `dashboards`, `notifications`, `toast`, `confirm`, `ui`). One of the two client state layers. See [ADR-005](adr/ADR-005-two-layer-client-state.md).

**clientMutationId / echo suppression** — A mutation tags itself with a `clientMutationId`; the matching SSE echo is skipped so the client doesn't double-apply its own change. Must be forgotten on error or the bookkeeping leaks. See [ADR-006](adr/ADR-006-rest-fetch-sse-patch.md).

**Hot / cold events** — Hot SSE events (reorder, item check/update) carry new state for in-place patching; cold events (create/delete) invalidate-and-refetch. See [ADR-006](adr/ADR-006-rest-fetch-sse-patch.md).

**Build-before-commit / broadcast-after-commit** — The SSE write choreography: construct the event dict before the DB commit (ORM live), broadcast after (subscribers see only committed state). See [ADR-015](adr/ADR-015-sse-write-choreography.md).

**Broadcast audience** — The set an SSE event goes to: `{dashboard.user_id} ∪ share principal_ids`. Miss a principal and their tab goes stale. See [ADR-015](adr/ADR-015-sse-write-choreography.md).

**Resync** — The catch-up an SSE client requests on reconnect via `Last-Event-ID` (or unconditionally on a fresh `EventSource`). See [FDR-008](fdr/FDR-008-realtime-sse.md).

**Closed sentinel** — The marker used to evict an overflowing SSE client so its stream ends and it reconnects with a resync instead of going silently deaf. See [ADR-004](adr/ADR-004-sse-over-websocket.md).

**useLocalDay** — The shared hook that ticks at the next local midnight (DST-safe) and on tab wake, so day-dependent views don't stick on yesterday on an always-on display. See [FDR-006](fdr/FDR-006-calendar-and-events.md).

**CF-Connecting-IP** — The Cloudflare-set real-client-IP header the rate limiter keys on; authoritative because the origin is reachable only through the Cloudflare Tunnel. See [ADR-013](adr/ADR-013-rate-limit-cf-connecting-ip.md).

**log_event / stage_notification** — Backend helpers that only `db.add` (activity events / notifications); the mutating route owns the single commit, keeping them atomic with the mutation. See [ADR-015](adr/ADR-015-sse-write-choreography.md).
