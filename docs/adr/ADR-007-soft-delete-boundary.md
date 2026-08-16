# ADR-007: The Delete Boundary — Recoverable Where Reconstruction Is Expensive

**Date:** 2026-08-14 (supersedes the 2026-07-20 record and its 2026-07-26 / 2026-07-27 amendments;
amended 2026-08-15 — calendar events gained a trash, not only an undo)

## Context

Deleting user content is destructive, and a household app benefits from a recovery path. But
recoverability is not free. A tombstone means every query must filter it, forgetting the filter
silently leaks deleted rows, and — since quotas landed (ADR-020) — the row keeps occupying the
owner's allowance until something purges it.

The earlier boundary split on **entity kind**: content was soft-deleted, containers were not, later
revised so that containers got a trash too. Applied to list items it produced a recovery path
nobody could reach. An item's tombstone was invisible in every view, no endpoint restored it, and
restoring its list did not bring it back — `restore_list` clears the list's own `deleted_at` and
nothing else. It cost a filter, thirty days of storage and a slice of the owner's quota, and
returned nothing. The quota refusal even told users to delete trashed items "again", which the API
answered with a 404.

## Decision

Split on **what it costs to reconstruct the thing**, not on what kind of thing it is.

- **Recoverable** — `Dashboard`, `List`, `CalendarEvent`. `DELETE` stamps `deleted_at`; the row
  disappears from every listing and access path and is restorable until purged.
- **Removed outright** — `ListItem`, `DashboardWidget`. No tombstone, no column, gone on `DELETE`.

A list item is a line of text; retyping it is cheaper than any machinery that could return it. A
calendar event carries a title, description, location, start, end, timezone, an all-day flag and a
recurrence rule, and owns per-occurrence overrides, participants and reminders — reconstructing one
by hand is the kind of loss a user would mind.

**Every recoverable resource gets both a trash and an undo** — a listing with a purge date, a
restore action and a permanent-delete action, plus a Restore on the deletion toast. The two are not
alternatives: undo covers the seconds after a misclick, where the recovery belongs next to the
mistake; the trash covers everything after that, and is the only one that can be found later.

This record briefly said an event needed only the undo, on the reasoning that a listing would be
ceremony around a misclick. That was wrong, and the way it was wrong is worth keeping: **the toast
lasts eight seconds and the tombstone lasts thirty days**, so between them sat a row that existed,
was restorable by API, and could not be reached from anywhere in the product. A recovery path that
expires long before the data does is not a recovery path.

Restore is a write and takes edit access on the parent dashboard, so a viewer cannot undo someone
else's delete, and an event whose dashboard is itself trashed cannot be restored on its own — it
returns with the dashboard.

### Consequences for the quota

Counts include tombstoned rows, because excluding them would make the ceiling bypassable by
deleting and recreating. That is only sound while each tombstoned resource has a reachable way to
free the space — which is exactly what the old boundary lacked. Now:

- **Dashboards and lists** are purged from the trash on demand.
- **Calendar events** are purged from their own trash on demand, like the other two. The quota
  refusal still names the horizon rather than the button, because waiting is what happens if nobody
  presses it.
- **List items** free their space immediately, which is where quota pressure actually lands.

## Consequences

- **The rule is stateable**: recoverable if reconstructing it by hand would be a real loss. A new
  entity is classified by answering that, not by asking whether it is "content" or a "container".
- **No unreachable recovery paths.** Every tombstone in the schema now has an endpoint that can
  clear it. That is the invariant this record exists to protect; a tombstone without one is a bug.
- **Dropping `list_items.deleted_at` was one-way.** The migration deletes tombstoned rows before
  dropping the column, because dropping it first would resurrect every one of them into its list.
  A rollback restores the column, not the rows.
- **Deleting an item is now instant and final.** There is no server-side window in which it can be
  recovered, by a user or by hand in the database. This is the cost of the decision, taken
  knowingly: the window that existed was never usable, and it was charged to the user's quota.
- **Every recoverable content query must still filter `deleted_at`** — a standing footgun, and an
  unfiltered query resurrects deleted rows. The surface is smaller than before by one table.
- **Cascade cleanup stays explicit**, in `reap_expired_trash` for the horizon and `purge_dashboard`
  / `purge_list` for a single row. Items are swept only as a list's cascade now; an item deleted on
  its own is already gone.
- **One put-away state, still.** There is no archive; a thing you want to keep but not see must
  stay in the list. Trash is reversible and expires, which is the only promise made.

## Related

- [ADR-020](ADR-020-resource-quotas.md) — the ceilings that made an unreachable tombstone a
  user-visible problem rather than dead weight.
