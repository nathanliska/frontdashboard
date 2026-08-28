# FDR-007: Notifications & Activity Feed

**Status:** Active
**Last reviewed:** 2026-08-26

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
dashboard edits, reconfigures of one widget, checkbox changes on one list, either kind of reorder,
and repeated edits to one list, item, or calendar event. Filtering narrows to one
of five categories — per-type rows made the control 26 deep, and every type sits in a category.
**Why:** Keyset pagination is stable under inserts, and scoping to self keeps it a personal audit
trail rather than a firehose. Readability used to be bought by dropping whole classes of event from
the *read* path, which made the feed disagree with its own log — recorded, pushed live, then gone.
Collapsing buys the same readability in the presentation layer, where being wrong costs a merged row
rather than a missing one, and filtering serves what hiding was really aiming at: finding one kind
of thing. Checkbox churn is 69% of a real log and the reason hiding was reached for; collapsing it
measured 112 events into 23 rows, which is the same quiet without the dishonesty.
**A collapsed run is one plain sentence, and no summary carries a count.** A `×N` badge was tried
and rejected: the split was principled but invisible, since a reader cannot tell why one row carries
a badge and the next does not, and being asked is the evidence that it does not work. Putting the
number in the sentence was tried next and reads as a second fact once the disclosure below states
the same figure. The count belongs on the control, said once. A run spanning several entities is
summarized against what contains them — "You updated checkboxes in Groceries" — since naming the
newest would claim the others never happened; the verb is *updated* because the same event type
carries unchecking and a run mixes both.
**A collapsed row opens to the events it stands for.** Collapsing is a presentation pass over the
feed already loaded, so the members are in hand and expanding costs no request and no group column.
The disclosure sits on every row that collapsed something rather than only the interesting ones: a
split a reader cannot predict is the shape this decision already tried and reverted. The control's
count names the lines it reveals, not the entities they touched — a checkbox toggled twice is two of
one and one of the other, and two numbers that disagree read as a miscount even when both are right.
A layout run's members
name the widget each gesture moved or resized, which is what makes opening one worth the click: the
saved layout carries every neighbour compaction reflowed, so the client reports what was grabbed and
the server records only what it can attribute to that dashboard. Older rows carry no gesture and keep
the countless sentence. Which rows are open is held by the feed against the event ids already opened, not by the row against its
own identity: a run grows at the front when SSE delivers and at the tail when a page is appended, so
no single event stays its name.
**Tradeoff:** A tidying session still costs one row per drag underneath, and a run interrupted by an
unrelated event shows as two sittings. A run reaching the end of what is loaded states a partial
count until the next page arrives: collapsing runs over the whole accumulated feed rather than per
page, so the seam re-merges instead of leaving two rows. It's not a cross-user or admin audit view;
that would be a separate surface.

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
