# FDR-007: Notifications & Activity Feed

**Status:** Active
**Last reviewed:** 2026-08-03

## Overview

Two related surfaces: an **in-app notification inbox** that tells a user about things that affect them
(a dashboard shared with them, access changed), and an **activity feed** that shows a log of the
caller's own actions. Both are driven by the same server-side event logging that powers real-time
delivery.

## Behavior

- **Notification inbox.** Unread-first, with mark-one-read and mark-all-read. New notifications arrive
  live via SSE.
- **Activity feed.** A keyset-paginated log of the caller's *own* events, filterable by category or
  by a single event type, with checkbox churn hidden from the unfiltered view.
- **What the feed shows, a reload also shows.** Live entries are gated on the same rule the endpoint
  serves, so nothing appears that a refresh would then take away — see decision 3.
- **Repeated churn reads as one entry.** A run of adjacent widget moves on the same dashboard
  renders as a single row with a count, rather than one row per drag.
- **Entries name what they touched.** Every event carries the name of its subject, so the generic
  "a dashboard" / "a list" fallbacks are for historic rows rather than anything written now.
  Redeeming an invite reads as *joining* — the actor gained access rather than granting it, which is
  the same event type seen from the other side. A retired event type reads back as English rather
  than printing its identifier, since old rows outlive the code that wrote them.
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

### 3. The feed is cached in the store, and a live append must answer the same query the endpoint does

**Decision:** Activity lives in the notifications store behind a loaded flag, not in the page, and a
mount does not refetch it. Mutation frames are appended to the cached feed as they arrive, but only
those `GET /api/activity` would itself return: `isOwnFeedActivity` re-implements the endpoint's
predicate — actor and active filter — and is the single gate on the append.
**Why:** Anything fetched on a page belongs in a store with a loaded flag, or returning to the page
re-reads what SSE has already delivered. The caching and the live append are one decision, not two:
a cached feed without the append would trade a redundant GET for a timeline that silently stops at
page load. But an *unfiltered* append is worse than none, because frames fan out to the whole
dashboard audience while the feed is self-scoped, so a co-editor's change rendered as "You…".
**Tradeoff:** One predicate is maintained on both sides of the wire and they can drift, and nothing
pins them together. A new event type that skips the append is invisible until a resync, and that
staleness would not show up in a test that only asserts the initial render.

### 4. Activity feed is self-scoped and keyset-paginated, filterable, and collapses churn

**Decision:** The feed shows only the caller's own events, paginated by keyset, and withholds
nothing. Adjacent runs of the same churn on the same subject collapse into one row: layout-only
dashboard edits, checkbox changes on one list, and either kind of reorder. Filtering narrows to one
of five categories — per-type rows made the control 26 deep, and every type sits in a category.
**Why:** Keyset pagination is stable under inserts, and scoping to self keeps it a personal audit
trail rather than a firehose. Readability used to be bought by dropping whole classes of event from
the *read* path, which made the feed disagree with its own log — recorded, pushed live, then gone.
Collapsing buys the same readability in the presentation layer, where being wrong costs a merged row
rather than a missing one, and filtering serves what hiding was really aiming at: finding one kind
of thing. Checkbox churn is 69% of a real log and the reason hiding was reached for; collapsing it
measured 112 events into 23 rows, which is the same quiet without the dishonesty.
**A collapsed run is one sentence that states its own count** — "You reordered items in List 3
times" — rather than a row with a separate `×N` beside it. Two shapes were tried and the split was
principled but invisible: a reader cannot tell why one row carries a badge and the next does not,
and being asked is the evidence that it does not work. The exception is a run spanning several
entities, where naming the newest would claim the others never happened; those summarize against
what contains them — "You updated 3 checkboxes in Groceries", counting **distinct checkboxes**, not
events, because one box toggled ten times is one box. The verb is *updated* because the same event
type carries unchecking and a run mixes both.
**Tradeoff:** A tidying session still costs one row per drag underneath, so a collapsed run split
across a page boundary shows as two rows, and one interrupted by an unrelated event shows as two
sittings. It's not a cross-user or admin audit view; that would be a separate surface.

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
