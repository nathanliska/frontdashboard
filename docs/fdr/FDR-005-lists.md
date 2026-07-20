# FDR-005: Lists

**Status:** Active
**Last reviewed:** 2026-07-20

## Overview

Lists are the app's checklists/task lists — shopping lists, chores, todos. Each list holds items with
optional metadata (due date, priority, category, assignee) and a manual order. Lists are edited in a
master/detail UI and surfaced on dashboards via the list widget ([FDR-003](FDR-003-widgets.md)).

## Behavior

- **Master/detail UI.** A sidebar of lists and a detail pane of items, with nested routes and a
  mobile slide navigation.
- **Item metadata.** Items support check/uncheck, due date, priority, category, assignee, and a manual
  sort order.
- **Manual order only.** Items keep their manual order; checked items stay in place rather than
  sinking. New items append last.
- **Drag-and-drop reorder.** Reorder items within a list and lists within the sidebar, via drag
  handles with keyboard support.
- **Active/Archived selector.** The sidebar defaults to Active (reorderable); Archived lists are
  viewable but not reorderable.
- **Archive before delete.** A list must be archived before it can be deleted (409 otherwise); delete
  cleans up bound widgets and shares. Deletes are soft.
- **Live updates.** Item checks/updates and reorders from another client patch in place with no
  refetch.

## Design Decisions

### 1. Reorder persists through transactional renumber endpoints

**Decision:** `PUT /lists/{id}/items/order` and `PUT /lists/order` renumber `sort_order` to `0..n-1`
under a row lock, and require the submitted id set to match the server's set exactly (409 otherwise).
DB CHECK constraints keep `sort_order` nonnegative.
**Why:** A full-set, transactional renumber is simple to reason about and can't leave gaps or
duplicate orders; the exact-set requirement catches a stale client operating on the wrong list
contents.
**Tradeoff:** The client must submit the complete ordered id set, not a single moved item.

### 2. Archived lists are excluded from the reorderable set

**Decision:** The server renumbers only non-archived lists, so a reorder's submitted set must equal
the active set; archived lists are viewable but not reorderable.
**Why:** Manual order is a property of the working (active) set; mixing archived lists into ordering
would be ambiguous.
**Tradeoff:** Reordering isn't available while viewing the archived filter.

### 3. Hot list events carry new state; cold events invalidate

**Decision:** Reorder and item check/update SSE events carry the new state (id order, or changed
field values) so clients patch in place; create/delete/archive invalidate-and-refetch.
**Why:** The frequent operations avoid a follow-up GET, while rarer operations keep the self-healing
refetch. See ADR-006.
**Tradeoff:** Hot-event payloads are part of the contract; a missing field silently forces the
divergence-refetch fallback.

### 4. Everything is soft-deleted

**Decision:** `List` and `ListItem` carry `deleted_at`, filtered in every query.
**Why:** List content is durable user data worth a recovery path. See ADR-007.
**Tradeoff:** Every list/item query must filter the tombstone or it leaks deleted rows.

## Access

Lists inherit access from the dashboard whose widget binds them (owner / editor / viewer). Their own
`/shares` endpoints are 409 stubs. See [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-006 (REST fetch + SSE patch), ADR-007 (soft delete), ADR-015 (SSE write
  choreography), ADR-001 (per-resource sharing)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
