# FDR-005: Lists

**Status:** Active
**Last reviewed:** 2026-08-12

## Overview

Lists are the app's checklists/task lists — shopping lists, chores, todos. Each list holds items with
optional metadata (due date, priority, category, assignee) and a manual order. Lists are edited in a
master/detail UI and surfaced on dashboards via the list widget ([FDR-003](FDR-003-widgets.md)).

## Behavior

- **Master/detail UI.** A sidebar of lists and a detail pane of items, with nested routes and a
  mobile slide navigation.
- **Item metadata.** Items support check/uncheck, due date, priority, category, assignee, and a manual
  sort order.
- **Due dates are the agenda's reminder source.** A `due_date` is a bare `YYYY-MM-DD` calendar day —
  no time, no zone — because the agenda's TODAY/OVERDUE split compares it as a string against the
  local day. Set it from a picker on the item row (its own control, not a field inside the text
  editor, which saves on blur and would close before a date could be chosen); the list widget shows
  it read-only. Only *priority, category and assignee* remain backend-only with no UI.
- **Manual order only.** Items keep their manual order; checked items stay in place rather than
  sinking. New items append last.
- **Drag-and-drop reorder.** Reorder items within a list and lists within the sidebar, via drag
  handles with keyboard support.
- **Active/Trash selector.** The sidebar defaults to Active (reorderable); Trash lists what has been
  deleted, with its purge deadline and a Restore action. Trash is fetched only when opened.
- **Move to trash.** Delete is a single action on any list — it stamps `deleted_at`, unbinds the
  widgets that showed the list, and is restorable for 30 days. There is no archive state and no
  archive-before-delete gate ([ADR-007](../adr/ADR-007-soft-delete-boundary.md)).
- **Live updates.** Item checks/updates and reorders from another client patch in place with no
  refetch.
- **A list you can no longer open says so.** Opening a link to a list that has been trashed, or that
  the caller has lost access to, renders an explanation and a "Back to lists" button rather than
  silently redirecting to the index — a bounce with no message reads as the app ignoring the click.
  The wording covers both causes without distinguishing them, since telling an outsider *which* one
  applies would confirm the list exists.

## Design Decisions

### 1. Reorder persists through transactional renumber endpoints

**Decision:** `PUT /lists/{id}/items/order` and `PUT /lists/order` renumber `sort_order` to `0..n-1`
under a row lock, and require the submitted id set to match the server's set exactly (409 otherwise).
DB CHECK constraints keep `sort_order` nonnegative.
**Why:** A full-set, transactional renumber is simple to reason about and can't leave gaps or
duplicate orders; the exact-set requirement catches a stale client operating on the wrong list
contents.
**Tradeoff:** The client must submit the complete ordered id set, not a single moved item.

### 2. Only live lists are reorderable

**Decision:** The server renumbers the dashboard's live lists, so a reorder's submitted set must equal
that set; trashed lists carry no order.
**Why:** Manual order is a property of the working set — trashed rows are not part of any ordering.
**Tradeoff:** Reordering isn't offered from the Trash view (there is nothing orderable there).

### 3. Hot list events carry new state; cold events invalidate

**Decision:** Reorder and item check/update SSE events carry the new state (id order, or changed
field values) so clients patch in place; create/delete invalidate-and-refetch.
**Why:** The frequent operations avoid a follow-up GET, while rarer operations keep the self-healing
refetch. See ADR-006.
**Tradeoff:** Hot-event payloads are part of the contract; a missing field silently forces the
divergence-refetch fallback.

### 4. Everything is soft-deleted

**Decision:** `List` and `ListItem` carry `deleted_at`, filtered in every query.
**Why:** List content is durable user data worth a recovery path. See ADR-007.
**Tradeoff:** Every list/item query must filter the tombstone or it leaks deleted rows.

Creating a list or an item is refused once the creator holds the configured ceiling of either,
with a message naming the limit. Trashed lists and items still count toward it until the reaper
purges them ([ADR-020](../adr/ADR-020-resource-quotas.md)); editing and deleting are never gated.
A trashed list can be purged outright by anyone who can edit its dashboard, which is what reclaims
the allowance early.

## Access

Lists inherit access from the dashboard whose widget binds them (owner / editor / viewer). Their own
`/shares` endpoints are 409 stubs. See [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-006 (REST fetch + SSE patch), ADR-007 (soft delete), ADR-015 (SSE write
  choreography), ADR-001 (per-resource sharing), ADR-020 (resource quotas)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
