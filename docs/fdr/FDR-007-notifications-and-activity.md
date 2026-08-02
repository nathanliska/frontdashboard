# FDR-007: Notifications & Activity Feed

**Status:** Active
**Last reviewed:** 2026-08-01

## Overview

Two related surfaces: an **in-app notification inbox** that tells a user about things that affect them
(a dashboard shared with them, access changed), and an **activity feed** that shows a log of the
caller's own actions. Both are driven by the same server-side event logging that powers real-time
delivery.

## Behavior

- **Notification inbox.** Unread-first, with mark-one-read and mark-all-read. New notifications arrive
  live via SSE.
- **Activity feed.** A keyset-paginated log of the caller's *own* events, with noisy event types
  hidden by default.
- **Losing access triggers a notification.** Share and unshare actions notify the affected users, and
  so does trashing a dashboard other people can see — see decision 5.
- **Revisiting either surface costs nothing.** Both the inbox and the feed are fetched once and then
  kept current by SSE, so switching tabs or navigating back re-renders from cache instead of
  refetching — and any extra pages "Load more" appended survive the return.
- **A failed load is distinguishable from an empty one.** When a fetch fails with nothing cached,
  the surface says so and offers a retry rather than rendering "No notifications", which would be
  indistinguishable from an empty inbox and offer no way forward.

## Design Decisions

### 1. Notifications are staged in the mutation's own transaction

**Decision:** `stage_notification(...)` (and `log_event(...)`) only `db.add`; the mutating route owns
the single commit, so notifications and activity land in the same transaction as the change that
caused them.
**Why:** A notification about a change that rolled back — or a change with no notification — would be
a lie. Same-transaction staging makes them atomic. See ADR-015.
**Tradeoff:** Routes must remember to stage before their single commit; there's no post-hoc
notification hook.

### 2. Live push over the shared SSE stream

**Decision:** New notifications push over the same multiplexed SSE connection as everything else,
after the commit that created them.
**Why:** Reuses the one-connection-per-user transport rather than a separate channel. See ADR-004 and
ADR-015 (build-before-commit, broadcast-after).
**Tradeoff:** Notification delivery shares the stream's overflow/reconnect behavior with all other
event types.

### 3. The feed is cached in the store, which is only safe because SSE keeps it current

**Decision:** Activity lives in the notifications store behind a loaded flag, not in the page, and a
mount does not refetch it. Every mutation frame is also appended to the cached feed as it arrives.
**Why:** Anything fetched on a page belongs in a store with a loaded flag, or returning to the page
re-reads what SSE has already delivered. The caching and the live append are one decision, not two:
a cached feed without the append would trade a redundant GET for a timeline that silently stops at
page load. `{ force: true }` exists for resync, where frames may have been missed.
**Tradeoff:** A new event type that skips the append is invisible on the feed until a resync, and the
staleness would not show up in a test that only asserts the initial render.

### 4. Activity feed is self-scoped and keyset-paginated, with noise hidden

**Decision:** The feed shows only the caller's own events, paginated by keyset, hiding noisy event
types by default.
**Why:** Keyset pagination is stable under inserts; scoping to self keeps it a personal audit trail
rather than a firehose; hiding noisy types keeps it readable.
**Tradeoff:** It's not a cross-user or admin audit view; that would be a separate surface.

### 5. Trashing a shared dashboard notifies the people who lose access

**Decision:** `DELETE /dashboards/{id}` stages a `dashboard.deleted` notification for every user
principal on the dashboard except the actor, alongside the SSE frame it already broadcast.
**Why:** Trashing stamps `deleted_at`, which `load_dashboard_access` filters, so everyone it was
shared with starts getting a bare 404 — with their bound widgets falling back to a generic "may have
been deleted". The SSE frame reaches only whoever is connected at that instant; the stored row is
what a returning user sees. It matters more than a missing courtesy because the reaper eventually
purges the cascade, **including lists and events those users authored themselves**.
**Tradeoff:** The notification explains the loss but cannot undo it — restore is owner-only, so a
shared user still has no route back. Whether they should be warned again *before* the purge, rather
than only at the moment of trashing, is open ([#58](../TODO.md)).

## Access

The inbox and feed are scoped to the authenticated user — you see your own notifications and your own
activity. Notification *audience* for a shared resource is the owner plus its share principals (see
ADR-015).

## Related

- **ADRs:** ADR-015 (SSE write choreography / same-transaction staging), ADR-004 (SSE transport),
  ADR-006 (REST fetch + SSE patch)
- **FDRs:** FDR-004 (Sharing & Access), FDR-008 (Real-Time Delivery)
