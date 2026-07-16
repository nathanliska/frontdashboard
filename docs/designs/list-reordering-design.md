# Design — Reorder lists and list items (drag-and-drop)

**Date:** 2026-07-16
**Status:** 🚧 Approved design — ready for implementation
**Related:** closes the reorder-input slice of `docs/references/review-findings.md` #14
**Surfaces:** lists sidebar (`ListsLayout`), list detail (`ListDetailPage`). Dashboard `ListWidget` is explicitly out of scope (see UX §).

## Theme

Let household members manually order both their **lists** (in the sidebar) and the **items
within a list** by drag-and-drop, persisted server-side and synced live to everyone who can
see the dashboard. The data model already supports this — `sort_order` exists on both `List`
and `ListItem` and is already the primary `ORDER BY` key — so the work is API surface, one
new frontend dependency, and UI wiring. No database migration.

Grounding note: this spec reflects the code as it is today (verified below), not an
idealized model. Item ordering is *already* half-wired; list ordering has the column but no
API exposure.

---

## Current behavior (verified in code)

- **Models** (`backend/app/models/list.py`): both `List` (line 36) and `ListItem` (line 51)
  have `sort_order: int` (`nullable=False, server_default="0"`). PKs are UUID. Index
  `ix_list_items_list_id` already covers `(list_id, sort_order, deleted_at)`.
- **Reads already sort by it**: `GET /lists` orders by `List.sort_order, List.created_at`
  (`routers/lists.py:204`); `GET /lists/{id}` orders items by
  `ListItem.sort_order, ListItem.created_at` (`:229`).
- **Item append** computes `next_order = max(sort_order)+1` under a `SELECT … FOR UPDATE`
  lock on the parent list (`:322-334`).
- **Item update** already accepts `sort_order` — `ListItemUpdate.sort_order` exists
  (`schemas/lists.py:45`) and the generic `PATCH` handler `setattr`s it (`:364-406`). It is
  returned in `ListItemResponse` (`:59`).
- **Gaps:**
  - `List.sort_order` is **not** in `ListUpdate`, **not** in `ListResponse`, and
    `create_list` never assigns it (every new list is `0`, tie-broken by `created_at`).
  - No batch/atomic reorder endpoint; per-item PATCH is the only path and would gap/collide
    under concurrent drags and emit one SSE event per moved row.
  - No drag-and-drop library. Only `react-grid-layout` (dashboards) is present.
  - Frontend `apiUpdateItem` / `updateListItem` only send `{ text?, checked? }`.

---

## Decisions (locked in brainstorming)

1. **Scope:** reorder both lists and items.
2. **Interaction:** drag-and-drop (with keyboard a11y), via **dnd-kit**.
3. **Checked items stay in place** — no auto-sink. Manual `sort_order` is the only order.
4. **Batch reorder endpoint** — atomic renumber in one transaction, one SSE event.
5. **Strict id-set match → 409** on divergence (not partial tolerance).
6. **Dashboard `ListWidget` does not get reorder** (nested inside react-grid-layout drag).

---

## Backend

### New endpoints

Both authz-scoped exactly like the existing list routes (dashboard membership / share),
and both do their work inside a single transaction holding a `FOR UPDATE` lock on the
parent row(s) so concurrent reorders serialize instead of interleaving.

#### `PUT /lists/{list_id}/items/order`
Body: `{ "item_ids": [UUID, …], "client_mutation_id": str | None }`

1. Lock the parent list row (`SELECT … FOR UPDATE`), authz-check as today.
2. Load the list's non-deleted item ids.
3. **Validate:** the submitted set must exactly equal the live set (same members, no
   missing, no extras, no duplicates). Mismatch → **409 Conflict**
   (`detail="List changed, please retry"`). The client refetches.
4. Renumber `sort_order = 0, 1, 2, …` in submitted order (one bulk update).
5. Emit **one** `list.item.reordered` activity event.

#### `PUT /lists/order`
Body: `{ "dashboard_id": UUID, "list_ids": [UUID, …], "client_mutation_id": str | None }`

Same pattern, scoped to the dashboard's non-deleted, **non-archived** lists. Renumbers
`List.sort_order`. Emits **one** `list.reordered` event.

> Ordering scope note: archived lists are excluded from the reorder set (they are hidden
> from the ordered sidebar). Their `sort_order` is left untouched; on unarchive they sort by
> their stale value tie-broken by `created_at`, which is acceptable — unarchive is rare and
> the user can re-drag.

### Schemas (`schemas/lists.py`)
- New `ItemReorder { item_ids: list[UUID]; client_mutation_id: str | None }`.
- New `ListReorder { dashboard_id: UUID; list_ids: list[UUID]; client_mutation_id: str | None }`.
- Add `sort_order: int` to `ListResponse` (already on `ListItemResponse`).
- **Boundary validation (satisfies review-findings #14's reorder slice):** both DTOs use
  `extra='forbid'`; `*_ids` is a non-empty list (`min_length=1`) with a sane upper bound and
  **no duplicate ids** (validated at the schema layer → 422, before any DB work).
- **Remove `sort_order` from `ListItemUpdate`.** Reordering now flows exclusively through the
  dedicated endpoint, which renumbers to a contiguous `0…n-1`. Dropping `sort_order` from the
  generic item PATCH closes finding #14's "negative/duplicate sort orders can reach
  persistence" concern for items — arbitrary `sort_order` can no longer be PATCHed in. The
  frontend `apiUpdateItem`/`updateListItem` already only send `{ text?, checked? }`, so no
  client contract breaks.

### Activity / SSE (`models/activity.py`)
- Add `EventType` values `list.reordered` and `list.item.reordered`.
- **Payload carries the new order itself** — the reorder event includes the full ordered id
  list (`item_ids` for an item reorder, `list_ids` for a list reorder), plus `dashboard_id`
  always and `list_id` for the item event. `client_mutation_id` echoed for optimistic dedup.
  Carrying the order in the payload is what lets receivers update **without a follow-up GET**
  (see frontend §).
- Broadcast via the existing `_broadcast_dashboard_event` → `manager.broadcast` fan-out to
  all dashboard member + share user ids. No fan-out changes.

### Why one event, not N
A drag that moves a row from position 8 → 1 renumbers 8 rows but is **one** logical
operation → one broadcast. This is the core reason for the batch endpoint over per-item
PATCH (which would emit one event per shifted row).

---

## Frontend

### Dependency
Add `@dnd-kit/core` + `@dnd-kit/sortable` (+ `@dnd-kit/accessibility` as pulled in).
Touch-capable and keyboard-accessible; no other dnd lib is present.

### Shared wrapper
A small `SortableList` component wrapping dnd-kit's `DndContext` + `SortableContext`,
reused by both the sidebar and the item list so drag behavior/feedback is defined once.
Each draggable row exposes a **drag handle** (grip icon) via `useSortable`.

### Wiring
- **Items:** `ListDetailPage` wraps `detail.items` in `SortableList`; `ListItemRow` renders
  the handle. On drop, compute the new id order and call a new `reorderListItems` mutation.
- **Lists:** `ListsLayout` wraps `filteredLists`; `ListSidebarRow` renders the handle. On
  drop, call `reorderLists`.
- **API (`api/lists.ts`):** `apiReorderItems(listId, itemIds, clientMutationId)` →
  `PUT /lists/{id}/items/order`; `apiReorderLists(dashboardId, listIds, clientMutationId)` →
  `PUT /lists/order`. Also widen `apiUpdateItem` types if needed (not required for reorder
  since reorder is its own endpoint).
- **Resource layer (`resources/listData.ts`):** `reorderListItems` / `reorderLists`
  optimistically reorder the cached array (via `patchListDetailById` /
  `patchListSummaryById` equivalents), fire the batch call echoing `client_mutation_id`, and
  **roll back + refetch** on error/409 with a toast ("Couldn't save order — refreshed").
- **SSE (`hooks/useSSE.ts` + `listData.ts`):** add the two new types to `LIST_EVENT_TYPES`.
  The handler **reorders the cached array in place from the payload id list — it does NOT
  issue a GET.** For an item reorder it permutes `detail.items` by `payload.item_ids`; for a
  list reorder it permutes the summaries by `payload.list_ids`. The actor's own echoed
  `client_mutation_id` is skipped so the optimistic state isn't re-applied.
  - **Narrow refetch fallback only on divergence:** if the payload id set doesn't match the
    ids currently in cache (an item was created/deleted the client hasn't seen yet), fall
    back to a single refetch of that one list. This is the *rare* path, not the common one.

> **No refetch storm.** This is a deliberate change from the initial sketch: reorder events
> update the cache directly from the payload rather than triggering a GET per event. It
> addresses a known pain point where SSE traffic fans out into a flood of GET requests, and
> as a bonus the reorder animates smoothly on observers' screens instead of snapping to a
> refetched order. Ordering authority still lives on the server — the payload *is* the
> server's authoritative order; the client is applying it, not inventing it.

---

## UX

- **Dedicated drag handle**, not whole-row drag. Rows already own tap targets — item
  checkbox + inline text edit; sidebar row navigates on click — so whole-row drag would
  fight them. Handle shows on hover (desktop), always present on touch.
- **Activation constraints:** `PointerSensor` with a small distance threshold (clicks not
  swallowed); `TouchSensor` with an activation delay + tolerance so vertical scrolling still
  works and a drag only begins on a deliberate press on the handle.
- **Feedback:** lifted row via `DragOverlay` (shadow + slight scale); other rows animate to
  open a gap at the drop target. Honors `prefers-reduced-motion` (dnd-kit default).
- **Auto-scroll** near viewport edges for long lists (dnd-kit built-in).
- **Keyboard:** focus handle → Space to pick up → arrows to move → Space to drop → Esc to
  cancel, with screen-reader move announcements (dnd-kit `KeyboardSensor`).
- **No handle** when a list/item collection has 0 or 1 entries (nothing to reorder).
- **Dashboard `ListWidget`: reorder disabled.** It lives inside react-grid-layout, whose own
  drag moves the widget; nested drag is a UX trap. Widget stays read-order.
- **Error recovery:** optimistic move is instant; on 409/network failure the row snaps back,
  the list refetches, and a brief toast explains it.

---

## Testing

### Backend (pytest)
- Renumbering: submitting a permuted id set produces `sort_order = 0…n-1` in that order.
- Id-set mismatch (missing / extra / duplicate id) → 409, no rows changed.
- Empty id list → 422 (schema rejection).
- Authz: non-member / non-share → 403/404 as with sibling routes.
- Soft-deleted items excluded from the required set and untouched.
- Archived lists excluded from `PUT /lists/order`.
- Exactly **one** activity event emitted per reorder call.
- Concurrency: two overlapping reorders on the same list serialize via the row lock; final
  state is a valid contiguous `0…n-1`.

### Frontend (vitest)
- Optimistic reorder applies to the cache immediately; rollback restores prior order on a
  rejected/409 mutation.
- A simulated drag-end calls the reorder mutation with the correct id order.
- Self-echoed SSE reorder event does not double-apply over optimistic state.
- **An SSE reorder event from another actor reorders the cache from the payload and issues
  NO GET** (assert the fetch/refetch path is not called). This is the anti-spam guarantee.
- Divergent payload (id set ≠ cached id set) triggers exactly one fallback refetch.

### Empty-body PATCH note
Since `sort_order` is removed from `ListItemUpdate`, confirm the existing empty-`{}`-PATCH →
422 test (finding #5 / `PatchModel`) still holds with the narrowed field set.

---

## Relation to review-findings.md

This work closes the **reorder-input slice of finding #14** ("Validate … and reorder inputs
at the boundary"). Finding #14 called for "a transactional bulk-reorder DTO"; the changelog
note (review-findings.md, lines 58-61) had dropped that DTO only because no bulk-reorder
endpoint existed yet, and left `sort_order ge=0` open. These endpoints supply exactly that
transactional, boundary-validated bulk-reorder path, and removing `sort_order` from
`ListItemUpdate` closes the negative/duplicate-sort-order-via-PATCH concern for items.

#14 is unphased (not in the rollout table), so there is no phase row to move. **On ship:**
add a `◐ Partially done` **Disposition** line to finding #14 (date + commit SHA(s), noting
the reorder slice + `sort_order` PATCH removal are done; dashboard name/layout/widget/profile
validation remain open) and a Changelog entry — in the same commit, per the standing rule.
The dashboard-layout reorder concern (finding #11) is **not** touched here.

## Out of scope / deferred
- Reordering inside the dashboard `ListWidget`.
- Auto-sink of checked items (explicitly rejected — stay in place).
- Cross-list item moves (drag an item from one list into another).
- The rest of finding #14 (dashboard name bounds, typed layout/widget config, `ProfileUpdate`,
  bounded headers) — separate work, left open.
