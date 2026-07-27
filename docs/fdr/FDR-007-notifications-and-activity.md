# FDR-007: Notifications & Activity Feed

**Status:** Active
**Last reviewed:** 2026-07-20

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
- **Sharing triggers notifications.** Share and unshare actions notify the affected users.

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

### 3. Activity feed is self-scoped and keyset-paginated, with noise hidden

**Decision:** The feed shows only the caller's own events, paginated by keyset, hiding noisy event
types by default.
**Why:** Keyset pagination is stable under inserts; scoping to self keeps it a personal audit trail
rather than a firehose; hiding noisy types keeps it readable.
**Tradeoff:** It's not a cross-user or admin audit view; that would be a separate surface.

## Access

The inbox and feed are scoped to the authenticated user — you see your own notifications and your own
activity. Notification *audience* for a shared resource is the owner plus its share principals (see
ADR-015).

## Related

- **ADRs:** ADR-015 (SSE write choreography / same-transaction staging), ADR-004 (SSE transport),
  ADR-006 (REST fetch + SSE patch)
- **FDRs:** FDR-004 (Sharing & Access), FDR-008 (Real-Time Delivery)
