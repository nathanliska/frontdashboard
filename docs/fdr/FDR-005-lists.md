# FDR-005: Lists

**Status:** Active
**Last reviewed:** 2026-08-21

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
- **Manual order is the only stored order.** New items append last. By default the detail page
  *draws* checked items in a collapsible "Checked (N)" pile at the bottom, keeping that same
  manual order — the pile is the rest of the list, not a log of one trip. A per-device toggle on
  the list header returns checked items to their in-place rendering; the collapse state is
  remembered per device too (see decision 4).
- **The add box is a toggle, not just an input.** Typing matches checked items (the pile doubles
  as the list's catalog); submitting an exact match or picking a suggestion unchecks that row
  instead of creating a duplicate — two shoppers adding "Milk" converge on one row. Escape
  dismisses the suggestions when a same-named new row is wanted on purpose. The list widget
  renders that same add box — matching, suggestions and Escape alike — showing fewer suggestions
  than the page, because the popup opens upward into a widget card that clips and the exact match
  ranks furthest from the input. It is kept however narrow the tile gets: it is the tile's only way
  to write, so it truncates like the rows above it rather than leaving no visible way to add. It
  carries the same toggle on its progress row and, with the pile
  on, shows only unchecked rows plus a "Checked (N)" line — expanding there is a transient peek
  that re-collapses on remount, where the page remembers its expand state, because the tile's job
  is the unchecked view. The dedupe itself is deliberately *not* gated on the preference — it
  prevents duplicates however the list is drawn — so an intentional same-named row always goes
  through Escape.
- **Drag-and-drop reorder.** Reorder items within a list and lists within the sidebar, via drag
  handles with keyboard support.
- **Active/Trash selector.** The sidebar defaults to Active (reorderable); Trash lists what has been
  deleted, with its purge deadline and a Restore action. Trash is fetched only when opened.
- **Move to trash.** Delete is a single action on any list — it stamps `deleted_at`, unbinds the
  widgets that showed the list, and is restorable for 30 days. The confirmation toast carries
  **Undo**, which restores the same list rather than recreating one, so recovering a misclick does
  not require knowing the Trash view exists. There is no archive state and no
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

### 4. The checked pile is display-only, and keeps the manual order

**Decision:** The pile is a render-time partition of the items a GET already returns — both zones
stay in `sort_order`, and nothing is stamped or stored to describe it. A drag in the active zone
rebuilds the full id set for the reorder endpoint with checked items held at their stored
positions; when the set no longer lines up (a row checked or removed mid-drag) the client resyncs
rather than submit the stored order, which the endpoint would accept as a silent no-op. The
pile-on/off and collapse preferences are per-device (localStorage), not synced state.
**Why:** Manual order is a first-class affordance here, so a pile that reorders itself by check
recency would contradict an order the user set deliberately — and recency is the wrong model for
a standing catalog, where the checked half is the rest of the list rather than a log of one trip.
Deriving the pile from data every client already holds also keeps it free of a column, a stamp on
the wire, and clock comparison.
**Tradeoff:** The preference doesn't follow the user across devices, and an accidental check is
found where the item has always sat rather than at the top of the pile.

### 5. Lists are recoverable; items are not

**Decision:** `List` carries `deleted_at` and a trash; `ListItem` is deleted outright.
**Why:** An item is a line of text, so retyping it costs less than any path that could return it —
and the path it used to have was unreachable. See [ADR-007](../adr/ADR-007-soft-delete-boundary.md).
**Tradeoff:** A misclicked item is gone at once, with no server-side window to recover it from.

Creating a list or an item is refused once the creator holds the configured ceiling of either, with
a message naming the limit and what actually frees room. A trashed list keeps its space until it is
purged, which anyone who can edit its dashboard may do outright to reclaim the allowance early;
deleted items free theirs immediately ([ADR-020](../adr/ADR-020-resource-quotas.md)). Editing and
deleting are never gated.

## Access

Lists inherit access from the dashboard whose widget binds them (owner / editor / viewer). Their own
`/shares` endpoints are 409 stubs. See [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-006 (REST fetch + SSE patch), ADR-007 (the delete boundary), ADR-015 (SSE write
  choreography), ADR-001 (per-resource sharing), ADR-020 (resource quotas)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
