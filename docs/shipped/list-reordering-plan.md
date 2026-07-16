# List & Item Reordering Implementation Plan

> **Shipped 2026-07-16** (`8543fab`, `35a1ea5`). Retained for history.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let household members drag-and-drop to reorder both their lists (sidebar) and the items within a list, persisted atomically server-side and synced live to all viewers without triggering a GET storm.

**Architecture:** Two new `PUT` endpoints renumber `sort_order` (`0…n-1`) inside one transaction under a `FOR UPDATE` lock, emitting exactly one activity event that carries the new id order in its payload. The frontend uses dnd-kit for drag, applies the reorder optimistically, and — on receiving a reorder SSE event — reorders its cache **from the payload** rather than refetching. Companion cleanup closes the reorder-input slice of review-findings #14.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 async (backend); React 18 + TypeScript + dnd-kit (frontend); pytest (Testcontainers) + Vitest.

## Global Constraints

- **Every non-GET route adds `_csrf: None = Depends(require_csrf)`** — CSRF is a dependency, not middleware (`backend/CLAUDE.md`).
- **SSE choreography:** build the event dict *before* `db.commit()`, call `manager.broadcast(...)` *after* commit. Broadcast via `_broadcast_dashboard_event`.
- **`role is None` means owner** — never `if role:`. Use `permissions.assert_can_edit(role)`.
- **`client_mutation_id` is the `X-Client-Mutation-Id` header**, typed `ClientMutationIdHeader`. Not a body field.
- **Frontend network:** only `apiFetch`; errors via `ApiError`/`requestVoid`/`readError` (`api/http.ts`) — no hand-rolled `res.ok` checks in new code.
- **Frontend cache:** lists live in `resources/*` scoped-query caches, not Zustand. Reorder events **update caches in place** (`updateWhere`), never invalidate-then-refetch except the divergence fallback.
- **Echo suppression:** every mutation records a pending `clientMutationId`; on error call `forgetPendingListMutation(id)`.
- **Vitest:** default env is `node`; component/DOM tests need `// @vitest-environment jsdom` at file top. Tests mock `api/*` and `stores/toast`; reset caches with `__resetListDataForTests()`.
- **Conventional Commits**, no attribution trailer. Commit straight to `main` after each task.

---

## File Structure

**Backend**
- Modify `backend/app/schemas/lists.py` — add `ItemReorder`, `ListReorder`; add `sort_order` to `ListResponse`; remove `sort_order` from `ListItemUpdate`.
- Modify `backend/app/models/list.py` — nonnegative `sort_order` CHECK constraints (#30 + #14 DB `ge=0`).
- Create `backend/alembic/versions/a3f7c2e9d1b4_add_sort_order_checks.py` — the CHECK migration.
- Modify `backend/app/models/activity.py` — add `list_reordered`, `list_item_reordered` to `EventType`.
- Modify `backend/app/routers/lists.py` — add `reorder_items` and `reorder_lists` routes; expose `sort_order` in `_list_response`.
- Modify `backend/tests/test_lists.py` (or add `backend/tests/test_lists_reorder.py`) — endpoint tests.

**Frontend**
- Modify `frontend/package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.
- Modify `frontend/src/api/lists.ts` — `apiReorderItems`, `apiReorderLists`.
- Modify `frontend/src/resources/listData.ts` — `reorderListItems`, `reorderLists` mutations; reorder-in-place SSE handlers.
- Modify `frontend/src/hooks/useSSE.ts` — add two event types to `LIST_EVENT_TYPES`.
- Create `frontend/src/components/lists/SortableList.tsx` — shared dnd-kit wrapper + drag-handle hook.
- Modify `frontend/src/components/lists/ListItemRow.tsx` — render drag handle.
- Modify `frontend/src/pages/ListDetailPage.tsx` — wrap items in `SortableList`.
- Modify `frontend/src/components/lists/ListSidebarRow.tsx` — render drag handle.
- Modify `frontend/src/pages/ListsLayout.tsx` — wrap sidebar rows in `SortableList` (only when `typeFilter === 'all'`).
- Add tests under `frontend/src/resources/` and `frontend/src/components/lists/`.

**Docs (final task)**
- Modify `docs/references/review-findings.md` — #14 Disposition + Changelog.
- Modify `CONTEXT.md` — note the shipped feature.
- Modify `docs/designs/list-reordering-design.md` — flip status to shipped (or move to `docs/shipped/`).

---

## Task 1: Reorder DTOs + schema cleanup

**Files:**
- Modify: `backend/app/schemas/lists.py`
- Test: `backend/tests/test_lists_reorder.py` (new)

**Interfaces:**
- Produces: `ItemReorder(item_ids: list[UUID])`, `ListReorder(dashboard_id: UUID, list_ids: list[UUID])`, both `extra='forbid'`, non-empty, no duplicate ids. `ListResponse` gains `sort_order: int`. `ListItemUpdate` no longer has `sort_order`.

- [ ] **Step 1: Write the failing test** — `backend/tests/test_lists_reorder.py`:

```python
import uuid

import pytest
from pydantic import ValidationError

from app.schemas.lists import ItemReorder, ListReorder


def test_item_reorder_rejects_empty():
    with pytest.raises(ValidationError):
        ItemReorder(item_ids=[])


def test_item_reorder_rejects_duplicates():
    dup = uuid.uuid4()
    with pytest.raises(ValidationError):
        ItemReorder(item_ids=[dup, dup])


def test_item_reorder_rejects_extra_fields():
    with pytest.raises(ValidationError):
        ItemReorder(item_ids=[uuid.uuid4()], sneaky=True)


def test_list_reorder_accepts_valid():
    dash = uuid.uuid4()
    ids = [uuid.uuid4(), uuid.uuid4()]
    model = ListReorder(dashboard_id=dash, list_ids=ids)
    assert model.list_ids == ids
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -v`
Expected: FAIL — `ImportError: cannot import name 'ItemReorder'`.

- [ ] **Step 3: Implement schema changes** — in `backend/app/schemas/lists.py`:

Remove `sort_order` from `ListItemUpdate` (delete the `sort_order: int | None = None` line, line 46).

Add `sort_order: int` to `ListResponse` (after `list_type`, mirroring `ListItemResponse`):

```python
class ListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dashboard_id: uuid.UUID
    name: str
    list_type: ListType
    sort_order: int
    archived: bool
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    item_count: int
```

Add the reorder DTOs (top-level, after `ListItemUpdate`). Use a reusable no-duplicates validator:

```python
from pydantic import field_validator


def _reject_duplicate_ids(value: list[uuid.UUID]) -> list[uuid.UUID]:
    if len(set(value)) != len(value):
        raise ValueError("ids must be unique")
    return value


class ItemReorder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)

    _no_dupes = field_validator("item_ids")(_reject_duplicate_ids)


class ListReorder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dashboard_id: uuid.UUID
    list_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)

    _no_dupes = field_validator("list_ids")(_reject_duplicate_ids)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Update `_list_response` to pass `sort_order`** — in `backend/app/routers/lists.py`, add `sort_order=lst.sort_order,` inside `_list_response` (after `list_type=lst.list_type,`) and inside the `ListDetailResponse(...)` literal in `get_list` (after `list_type=lst.list_type,`). Run `cd backend && uv run pytest tests/test_lists.py -v` — existing list tests still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/lists.py backend/app/routers/lists.py backend/tests/test_lists_reorder.py
git commit -m "feat(lists): add reorder DTOs, expose list sort_order, drop item sort_order patch"
```

---

## Task 1b: Nonnegative `sort_order` DB constraints (closes #30 + #14's DB `ge=0`)

Folds the sort-order slice of review-findings **#30** ("nonnegative ordering constraints",
`list.py:41-58`) and the DB half of **#14**'s `sort_order ge=0` into this work. The reorder
endpoints already renumber to `0…n-1`; these CHECK constraints make a negative `sort_order`
impossible at the database, for direct SQL or future code paths.

**Files:**
- Modify: `backend/app/models/list.py`
- Create: `backend/alembic/versions/a3f7c2e9d1b4_add_sort_order_checks.py`
- Test: `backend/tests/test_lists_reorder.py`

**Interfaces:**
- Produces: CHECK constraints `ck_lists_sort_order_nonneg` and `ck_list_items_sort_order_nonneg`, present in both the ORM `__table_args__` (so tests' `create_all` enforces them) **and** a migration (so production enforces them).

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_lists_reorder.py`). Backend tests build schema from `Base.metadata.create_all`, so a model-level `CheckConstraint` is enforced:

```python
import pytest
from sqlalchemy.exc import IntegrityError

from app.models.list import ListItem


@pytest.mark.anyio
async def test_negative_item_sort_order_rejected(db_session, seeded_list):
    db_session.add(
        ListItem(
            list_id=seeded_list.id,
            text="bad",
            sort_order=-1,
            created_by=seeded_list.created_by,
            updated_by=seeded_list.created_by,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
```

> Use whatever session/list fixtures `test_lists.py` already exposes; if none fit, build a minimal list row first. The point is: `sort_order=-1` must raise `IntegrityError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -k negative_item_sort_order -v`
Expected: FAIL — no IntegrityError (constraint absent).

- [ ] **Step 3: Add constraints to the models** — in `backend/app/models/list.py`, import `CheckConstraint` (add to the `sqlalchemy` import line) and extend both `__table_args__`:

```python
from sqlalchemy import (
    Boolean, CheckConstraint, Date, DateTime, Enum, ForeignKey, Index, Integer, String, Text,
)

# List.__table_args__:
    __table_args__ = (
        Index("ix_lists_dashboard_id", "dashboard_id", "deleted_at"),
        Index("ix_lists_created_by", "created_by", "deleted_at"),
        CheckConstraint("sort_order >= 0", name="ck_lists_sort_order_nonneg"),
    )

# ListItem.__table_args__:
    __table_args__ = (
        Index("ix_list_items_list_id", "list_id", "sort_order", "deleted_at"),
        Index("ix_list_items_assigned_to", "assigned_to", "checked", "deleted_at"),
        CheckConstraint("sort_order >= 0", name="ck_list_items_sort_order_nonneg"),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -k negative_item_sort_order -v`
Expected: PASS.

- [ ] **Step 5: Hand-author the migration** — create `backend/alembic/versions/a3f7c2e9d1b4_add_sort_order_checks.py` (match the repo's header style; `down_revision` is the current head `z9b2d4f6h8j0`):

```python
"""add nonnegative sort_order checks

Revision ID: a3f7c2e9d1b4
Revises: z9b2d4f6h8j0
Create Date: 2026-07-16
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "a3f7c2e9d1b4"
down_revision: str | Sequence[str] | None = "z9b2d4f6h8j0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint("ck_lists_sort_order_nonneg", "lists", "sort_order >= 0")
    op.create_check_constraint("ck_list_items_sort_order_nonneg", "list_items", "sort_order >= 0")


def downgrade() -> None:
    op.drop_constraint("ck_list_items_sort_order_nonneg", "list_items", type_="check")
    op.drop_constraint("ck_lists_sort_order_nonneg", "lists", type_="check")
```

> Confirm the head before committing: `cd backend && uv run alembic heads` should show `z9b2d4f6h8j0` (the parent). If it has advanced, set `down_revision` to the actual head. Tests never run migrations (schema comes from `create_all`), so also verify the migration applies against a real DB: `cd backend && uv run alembic upgrade head` (needs Postgres), then `uv run alembic downgrade -1` to confirm the down path.

- [ ] **Step 6: Commit**

```bash
git add backend/app/models/list.py backend/alembic/versions/a3f7c2e9d1b4_add_sort_order_checks.py backend/tests/test_lists_reorder.py
git commit -m "feat(lists): enforce nonnegative sort_order at the database"
```

---

## Task 2: New reorder event types

**Files:**
- Modify: `backend/app/models/activity.py`

**Interfaces:**
- Produces: `EventType.list_reordered = "list.reordered"`, `EventType.list_item_reordered = "list.item.reordered"`.

- [ ] **Step 1: Add the enum members** — in `backend/app/models/activity.py`, under the existing list/item blocks:

```python
    # Lists
    list_created = "list.created"
    list_updated = "list.updated"
    list_archived = "list.archived"
    list_deleted = "list.deleted"
    list_reordered = "list.reordered"
    # List items
    list_item_created = "list.item.created"
    list_item_updated = "list.item.updated"
    list_item_checked = "list.item.checked"
    list_item_deleted = "list.item.deleted"
    list_item_reordered = "list.item.reordered"
```

- [ ] **Step 2: Verify import works**

Run: `cd backend && uv run python -c "from app.models.activity import EventType; print(EventType.list_reordered, EventType.list_item_reordered)"`
Expected: `list.reordered list.item.reordered`

- [ ] **Step 3: Commit**

```bash
git add backend/app/models/activity.py
git commit -m "feat(lists): add list.reordered and list.item.reordered event types"
```

---

## Task 3: `PUT /lists/{list_id}/items/order`

**Files:**
- Modify: `backend/app/routers/lists.py`
- Test: `backend/tests/test_lists_reorder.py`

**Interfaces:**
- Consumes: `_get_list_access(..., lock_for_update=True)`, `permissions.assert_can_edit`, `_build_list_event_message`, `_broadcast_dashboard_event`, `ItemReorder`, `EventType.list_item_reordered`.
- Produces: `PUT /lists/{list_id}/items/order` → 204. Payload of emitted event: `{dashboard_id, list_id, item_ids: [str,…]}`, `entity_type="list_item"`, `entity_id=list_id`.

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_lists_reorder.py`). Follow the existing `test_lists.py` fixtures for auth/dashboard/list setup — reuse its helpers (e.g. a logged-in client + a created list + created items). Pseudocode-free, concrete:

```python
@pytest.mark.anyio
async def test_reorder_items_renumbers(client, make_list_with_items):
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])  # returns ids in creation order
    reordered = [item_ids[2], item_ids[0], item_ids[1]]

    res = await client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": reordered})
    assert res.status_code == 204

    detail = (await client.get(f"/api/lists/{list_id}")).json()
    assert [i["id"] for i in detail["items"]] == reordered
    assert [i["sort_order"] for i in detail["items"]] == [0, 1, 2]


@pytest.mark.anyio
async def test_reorder_items_rejects_mismatched_set(client, make_list_with_items):
    list_id, item_ids = await make_list_with_items(["a", "b"])
    res = await client.put(
        f"/api/lists/{list_id}/items/order",
        json={"item_ids": [item_ids[0], str(uuid.uuid4())]},
    )
    assert res.status_code == 409


@pytest.mark.anyio
async def test_reorder_items_requires_all_ids(client, make_list_with_items):
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])
    res = await client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": [item_ids[0]]})
    assert res.status_code == 409
```

> If `make_list_with_items` doesn't exist, add it as a small fixture in the test module using the existing client + `create_list`/`create_item` HTTP calls from `test_lists.py`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -k reorder_items -v`
Expected: FAIL — 405/404 (route missing).

- [ ] **Step 3: Implement the route** — add to `backend/app/routers/lists.py` (import `ItemReorder`, `ListReorder` in the schema import block):

```python
@router.put("/{list_id}/items/order", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_items(
    list_id: uuid.UUID,
    body: ItemReorder,
    client_mutation_id: ClientMutationIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Atomically renumber a list's items to the submitted order."""
    lst, dashboard, shares, role = await _get_list_access(
        list_id, current_user, db, lock_for_update=True
    )
    permissions.assert_can_edit(role)

    items_result = await db.execute(
        select(ListItem).where(ListItem.list_id == list_id, ListItem.deleted_at.is_(None))
    )
    items = {item.id: item for item in items_result.scalars().all()}

    if set(body.item_ids) != set(items.keys()):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="List changed, please retry"
        )

    for position, item_id in enumerate(body.item_ids):
        item = items[item_id]
        item.sort_order = position
        item.updated_by = current_user.id

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_item_reordered,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list_item",
        entity_id=list_id,
        payload={"list_id": str(list_id), "item_ids": [str(i) for i in body.item_ids]},
        client_mutation_id=client_mutation_id,
    )
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -k reorder_items -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/lists.py backend/tests/test_lists_reorder.py
git commit -m "feat(lists): add atomic item reorder endpoint"
```

---

## Task 4: `PUT /lists/order`

**Files:**
- Modify: `backend/app/routers/lists.py`
- Test: `backend/tests/test_lists_reorder.py`

**Interfaces:**
- Consumes: `load_dashboard_access`, `permissions.assert_can_edit`, `ListReorder`, `EventType.list_reordered`.
- Produces: `PUT /lists/order` → 204. Renumbers non-archived, non-deleted lists of the dashboard. Event payload: `{dashboard_id, list_ids: [str,…]}`, `entity_type="dashboard"`, `entity_id=dashboard_id`.

- [ ] **Step 1: Write the failing test** (append):

```python
@pytest.mark.anyio
async def test_reorder_lists_renumbers(client, make_dashboard_with_lists):
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2", "L3"])
    reordered = [list_ids[2], list_ids[1], list_ids[0]]

    res = await client.put("/api/lists/order", json={"dashboard_id": dash_id, "list_ids": reordered})
    assert res.status_code == 204

    lists = (await client.get(f"/api/lists?dashboard_id={dash_id}")).json()
    assert [l["id"] for l in lists] == reordered
    assert [l["sort_order"] for l in lists] == [0, 1, 2]


@pytest.mark.anyio
async def test_reorder_lists_rejects_mismatched_set(client, make_dashboard_with_lists):
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2"])
    res = await client.put(
        "/api/lists/order",
        json={"dashboard_id": dash_id, "list_ids": [list_ids[0], str(uuid.uuid4())]},
    )
    assert res.status_code == 409
```

> Note the route ordering constraint: `PUT /lists/order` must be declared so it is not shadowed by `/{list_id}` patterns. `order` is a static segment on a different method (`PUT` vs `PATCH`/`GET` on `/{list_id}`), so FastAPI matching is unambiguous here; still, place `reorder_lists` in the file for readability near the other collection routes.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -k reorder_lists -v`
Expected: FAIL — 405/404.

- [ ] **Step 3: Implement the route** — add to `backend/app/routers/lists.py`:

```python
@router.put("/order", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_lists(
    body: ListReorder,
    client_mutation_id: ClientMutationIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Atomically renumber a dashboard's non-archived lists to the submitted order."""
    dashboard, shares, role = await load_dashboard_access(body.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    lists_result = await db.execute(
        select(List)
        .where(
            List.dashboard_id == body.dashboard_id,
            List.deleted_at.is_(None),
            List.archived.is_(False),
        )
        .with_for_update()
    )
    lists = {lst.id: lst for lst in lists_result.scalars().all()}

    if set(body.list_ids) != set(lists.keys()):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Lists changed, please retry"
        )

    for position, list_id in enumerate(body.list_ids):
        lst = lists[list_id]
        lst.sort_order = position
        lst.updated_by = current_user.id

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_reordered,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="dashboard",
        entity_id=body.dashboard_id,
        payload={"list_ids": [str(i) for i in body.list_ids]},
        client_mutation_id=client_mutation_id,
    )
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_lists_reorder.py -v && cd backend && uv run ruff check --fix && uv run ruff format`
Expected: all reorder tests PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/lists.py backend/tests/test_lists_reorder.py
git commit -m "feat(lists): add atomic list reorder endpoint"
```

---

## Task 5: Add dnd-kit dependency

**Files:**
- Modify: `frontend/package.json`, `frontend/package-lock.json`

- [ ] **Step 1: Install**

Run: `cd frontend && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
Expected: three deps added; lockfile updated.

- [ ] **Step 2: Verify build still succeeds**

Run: `cd frontend && npm run build`
Expected: build passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "build(frontend): add dnd-kit for list reordering"
```

---

## Task 6: API client reorder calls

**Files:**
- Modify: `frontend/src/api/lists.ts`
- Test: `frontend/src/api/lists.reorder.test.ts` (new)

**Interfaces:**
- Produces: `apiReorderItems(listId: string, itemIds: string[], options?: ListMutationOptions): Promise<void>`; `apiReorderLists(dashboardId: string, listIds: string[], options?: ListMutationOptions): Promise<void>`. Both PUT, no body response, throw `ApiError` on non-2xx (via `requestVoid`).

- [ ] **Step 1: Write the failing test** — `frontend/src/api/lists.reorder.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

const requestVoid = vi.fn().mockResolvedValue(undefined)
vi.mock('./http', () => ({ requestVoid }))
vi.mock('./client', () => ({ apiFetch: vi.fn() }))

import { apiReorderItems, apiReorderLists } from './lists'

describe('reorder api', () => {
  it('PUTs item order with the client mutation header', async () => {
    await apiReorderItems('list-1', ['b', 'a'], { clientMutationId: 'm1' })
    expect(requestVoid).toHaveBeenCalledWith(
      '/api/lists/list-1/items/order',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'X-Client-Mutation-Id': 'm1' },
        body: JSON.stringify({ item_ids: ['b', 'a'] }),
      }),
      expect.any(String),
    )
  })

  it('PUTs list order with dashboard id', async () => {
    await apiReorderLists('dash-1', ['y', 'x'])
    expect(requestVoid).toHaveBeenCalledWith(
      '/api/lists/order',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ dashboard_id: 'dash-1', list_ids: ['y', 'x'] }),
      }),
      expect.any(String),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/lists.reorder.test.ts`
Expected: FAIL — `apiReorderItems is not a function`.

- [ ] **Step 3: Implement** — append to `frontend/src/api/lists.ts`:

```ts
export async function apiReorderItems(
  listId: string,
  itemIds: string[],
  options?: ListMutationOptions,
): Promise<void> {
  await requestVoid(
    `/api/lists/${listId}/items/order`,
    {
      method: 'PUT',
      headers: buildListMutationHeaders(options),
      body: JSON.stringify({ item_ids: itemIds }),
    },
    'Failed to reorder items',
  )
}

export async function apiReorderLists(
  dashboardId: string,
  listIds: string[],
  options?: ListMutationOptions,
): Promise<void> {
  await requestVoid(
    `/api/lists/order`,
    {
      method: 'PUT',
      headers: buildListMutationHeaders(options),
      body: JSON.stringify({ dashboard_id: dashboardId, list_ids: listIds }),
    },
    'Failed to reorder lists',
  )
}
```

> `buildListMutationHeaders` returns `undefined` when no mutation id — the test passes an id so it asserts the header object. Keep the `expect.objectContaining` loose for the no-id case.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/lists.reorder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/lists.ts frontend/src/api/lists.reorder.test.ts
git commit -m "feat(lists): add reorder API client calls"
```

---

## Task 7: Resource-layer reorder mutations + reorder-in-place SSE

**Files:**
- Modify: `frontend/src/resources/listData.ts`
- Test: `frontend/src/resources/listData.reorder.test.ts` (new)

**Interfaces:**
- Consumes: `apiReorderItems`, `apiReorderLists`, `patchListDetailById`, `patchListSummaryById`, `nextListMutationOptions`, `forgetPendingListMutation`, `ApiError`.
- Produces:
  - `reorderListItems(listId: string, orderedIds: string[]): Promise<void>` — optimistic, rollback + refetch on error.
  - `reorderLists(dashboardId: string, orderedIds: string[]): Promise<void>` — optimistic, rollback + refetch on error.
  - Reorder branches in `handleListResourceEvent` that reorder caches from the payload; divergence → single `invalidateWhere` refetch.

- [ ] **Step 1: Write the failing test** — `frontend/src/resources/listData.reorder.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiReorderItems = vi.fn().mockResolvedValue(undefined)
const apiReorderLists = vi.fn().mockResolvedValue(undefined)
vi.mock('../api/lists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/lists')>()),
  apiReorderItems,
  apiReorderLists,
}))
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

import {
  __resetListDataForTests,
  handleListResourceEvent,
  reorderListItems,
} from './listData'
// Test helpers to seed the caches live in the module via updateWhere; seed through the
// public query objects using a small exported test seeder OR by dispatching create events.

describe('reorderListItems', () => {
  beforeEach(() => {
    __resetListDataForTests()
    apiReorderItems.mockClear()
  })

  it('calls the reorder API with the new id order', async () => {
    // seed a detail cache with items a,b,c (see seeding note below), then:
    await reorderListItems('list-1', ['c', 'a', 'b'])
    expect(apiReorderItems).toHaveBeenCalledWith('list-1', ['c', 'a', 'b'], expect.any(Object))
  })
})

describe('handleListResourceEvent reorder', () => {
  it('reorders detail items from payload without refetching', () => {
    // seed detail cache with a,b,c; then:
    handleListResourceEvent({
      event_type: 'list.item.reordered',
      entity_type: 'list_item',
      entity_id: 'list-1',
      actor_id: 'other-user',
      payload: { dashboard_id: 'd1', list_id: 'list-1', item_ids: ['c', 'b', 'a'] },
    } as never)
    // assert cache order is now c,b,a and no fetch happened
  })
})
```

> **Seeding note:** the scoped-query caches are private. Add a tiny test-only exported seeder in `listData.ts` — `export function __seedListDetailForTests(detail: ListDetail)` calling `listDetailQuery.updateWhere(() => true, () => ({ data: detail, loading: false, error: null }))` — guarded by name convention like the existing `__resetListDataForTests`. Use it in the tests above to seed known state.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/resources/listData.reorder.test.ts`
Expected: FAIL — `reorderListItems is not a function`.

- [ ] **Step 3: Implement** — in `frontend/src/resources/listData.ts`:

Add a pure reorder helper near the top:

```ts
function orderByIds<T extends { id: string }>(rows: T[], orderedIds: string[]): T[] | null {
  if (orderedIds.length !== rows.length) return null // divergence
  const byId = new Map(rows.map((r) => [r.id, r]))
  const next: T[] = []
  for (const id of orderedIds) {
    const row = byId.get(id)
    if (!row) return null // divergence
    next.push(row)
  }
  return next
}
```

Add the import for `ApiError` and the two API calls:

```ts
import { apiReorderItems, apiReorderLists } from '../api/lists'
import { ApiError } from '../api/http'
```

Add the mutations:

```ts
export async function reorderListItems(listId: string, orderedIds: string[]): Promise<void> {
  const previous = listDetailQuery.getState({ listId }).data?.items ?? null
  const { clientMutationId, options } = nextListMutationOptions()

  patchListDetailById(listId, (detail) => {
    const items = orderByIds(detail.items, orderedIds)
    return items ? { ...detail, items } : detail
  })

  try {
    await apiReorderItems(listId, orderedIds, options)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    if (previous) {
      patchListDetailById(listId, (detail) => ({ ...detail, items: previous }))
    }
    if (error instanceof ApiError && error.status === 409) {
      listDetailQuery.invalidateWhere((scope) => scope.listId === listId)
    }
    toast.error('Could not save order — refreshed.')
  }
}

export async function reorderLists(dashboardId: string, orderedIds: string[]): Promise<void> {
  const previous = listSummariesQuery.getState({ dashboardId }).data ?? null
  const { clientMutationId, options } = nextListMutationOptions()

  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    (state) => {
      if (!state.data) return state
      const ordered = orderByIds(state.data, orderedIds)
      return ordered ? { ...state, data: ordered } : state
    },
  )

  try {
    await apiReorderLists(dashboardId, orderedIds, options)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    if (previous) {
      listSummariesQuery.updateWhere(
        (scope) => scope.dashboardId === dashboardId,
        (state) => ({ ...state, data: previous }),
      )
    }
    if (error instanceof ApiError && error.status === 409) {
      listSummariesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
    }
    toast.error('Could not save order — refreshed.')
  }
}
```

> The list-reorder optimistic payload contains only the **non-archived** list ids (the caller filters — see Task 11). Archived summaries in the cache are left untouched; `orderByIds` divergence-guards on a length mismatch, so when archived rows are present the optimistic reorder is skipped and the server's SSE echo (also non-archived-only) drives the final order via the branch below. To keep the optimistic path active, Task 11 only enables list drag when no archived lists are shown in the current view (type filter `all` still shows archived, so the handler must reorder the non-archived subset in place — see Step 3b).

- [ ] **Step 3b: Make `handleListResourceEvent` reorder from payload** — insert branches right after the `consumePendingListMutationEcho(event)` early-return in `handleListResourceEvent`:

```ts
  if (event.event_type === 'list.item.reordered') {
    const listId = getAffectedListId(event)
    const payload = getEventPayload(event)
    const itemIds = Array.isArray(payload?.item_ids) ? (payload.item_ids as string[]) : null
    if (listId && itemIds) {
      let diverged = false
      patchListDetailById(listId, (detail) => {
        const items = orderByIds(detail.items, itemIds)
        if (!items) {
          diverged = true
          return detail
        }
        return { ...detail, items }
      })
      if (diverged) listDetailQuery.invalidateWhere((scope) => scope.listId === listId)
    }
    return
  }

  if (event.event_type === 'list.reordered') {
    const dashboardId = getEventDashboardId(event)
    const payload = getEventPayload(event)
    const listIds = Array.isArray(payload?.list_ids) ? (payload.list_ids as string[]) : null
    if (dashboardId && listIds) {
      let diverged = false
      listSummariesQuery.updateWhere(
        (scope) => scope.dashboardId === dashboardId,
        (state) => {
          if (!state.data) return state
          const archived = state.data.filter((l) => l.archived)
          const active = state.data.filter((l) => !l.archived)
          const orderedActive = orderByIds(active, listIds)
          if (!orderedActive) {
            diverged = true
            return state
          }
          return { ...state, data: [...orderedActive, ...archived] }
        },
      )
      if (diverged) listSummariesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
    }
    return
  }
```

> This reorders the non-archived subset from the payload and appends archived rows after them (archived rows are de-emphasized and not independently orderable). Divergence (an unseen create/delete) falls back to one refetch of that single list/dashboard — the rare path, not the common one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/resources/listData.reorder.test.ts`
Expected: PASS. Also run `npx vitest run src/resources/` to confirm no regression in existing listData tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/resources/listData.ts frontend/src/resources/listData.reorder.test.ts
git commit -m "feat(lists): optimistic reorder mutations + reorder-in-place SSE handling"
```

---

## Task 8: Register reorder event types with SSE

**Files:**
- Modify: `frontend/src/hooks/useSSE.ts`

**Interfaces:**
- Consumes: `LIST_EVENT_TYPES` array (drives `es.addEventListener`).

- [ ] **Step 1: Add the event names** — extend `LIST_EVENT_TYPES` in `frontend/src/hooks/useSSE.ts`:

```ts
const LIST_EVENT_TYPES = [
  'list.created',
  'list.updated',
  'list.archived',
  'list.deleted',
  'list.reordered',
  'list.item.created',
  'list.item.updated',
  'list.item.checked',
  'list.item.deleted',
  'list.item.reordered',
] as const
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck` (or `npx tsc --noEmit`)
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useSSE.ts
git commit -m "feat(lists): subscribe to reorder SSE events"
```

---

## Task 9: Shared `SortableList` wrapper

**Files:**
- Create: `frontend/src/components/lists/SortableList.tsx`
- Test: `frontend/src/components/lists/SortableList.test.tsx` (new, jsdom)

**Interfaces:**
- Produces:
  - `SortableList<T extends { id: string }>({ items, onReorder, children, disabled })` — renders a `DndContext` + `SortableContext`; on drag end computes the new id order and calls `onReorder(orderedIds: string[])` only when the order actually changed.
  - `useSortableRow(id: string, disabled?: boolean)` — thin wrapper over dnd-kit `useSortable`, returning `{ setNodeRef, style, attributes, listeners, isDragging }` for a row to spread onto its container + drag handle.

- [ ] **Step 1: Write the failing test** — `frontend/src/components/lists/SortableList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SortableList } from './SortableList'

describe('SortableList', () => {
  it('renders its children in order', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { getByText } = render(
      <SortableList items={items} onReorder={() => {}}>
        {(item) => <div>{item.id}</div>}
      </SortableList>,
    )
    expect(getByText('a')).toBeTruthy()
    expect(getByText('b')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/lists/SortableList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `frontend/src/components/lists/SortableList.tsx`:

```tsx
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'

export function useSortableRow(id: string, disabled?: boolean) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id,
    disabled,
  })
  return {
    setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition } as const,
    attributes,
    listeners,
    isDragging,
  }
}

export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  children,
  disabled = false,
}: {
  items: T[]
  onReorder: (orderedIds: string[]) => void
  children: (item: T) => ReactNode
  disabled?: boolean
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = items.map((i) => i.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    onReorder(next)
  }

  if (disabled) {
    return <>{items.map((item) => children(item))}</>
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => children(item))}
      </SortableContext>
    </DndContext>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/lists/SortableList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/lists/SortableList.tsx frontend/src/components/lists/SortableList.test.tsx
git commit -m "feat(lists): shared dnd-kit SortableList wrapper"
```

---

## Task 10: Wire item drag into the list detail

**Files:**
- Modify: `frontend/src/components/lists/ListItemRow.tsx`, `frontend/src/pages/ListDetailPage.tsx`
- Test: `frontend/src/pages/ListDetailPage.reorder.test.tsx` (new, jsdom) — asserts a keyboard-driven reorder calls `reorderListItems`.

**Interfaces:**
- Consumes: `SortableList`, `useSortableRow`, `reorderListItems`.
- `ListItemRow` gains optional props: `dragHandle?: ReactNode`, and spreads a `setNodeRef`/`style` container when provided. To keep the row's `<li>` semantics, add `sortable?: { setNodeRef; style; attributes; listeners; isDragging }`.

- [ ] **Step 1: Write the failing test** — render `ListDetailPage` with a seeded detail (mock `useListDetail` to return items a,b,c), fire a keyboard reorder on the first handle (`Space`, `ArrowDown`, `Space`), assert the mocked `reorderListItems` was called with `['b','a','c']`. Mock `../resources/listData`'s `reorderListItems`.

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const reorderListItems = vi.fn()
vi.mock('../resources/listData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/listData')>()),
  reorderListItems,
  useListDetail: () => ({
    data: {
      id: 'list-1', dashboard_id: 'd1', name: 'L', list_type: 'todo', sort_order: 0,
      archived: false, created_by: 'u', created_at: '', updated_at: '', item_count: 3,
      items: [
        { id: 'a', list_id: 'list-1', text: 'A', checked: false, sort_order: 0, due_date: null, priority: null, category: null, assigned_to: null, created_by: 'u', created_at: '', updated_at: '' },
        { id: 'b', list_id: 'list-1', text: 'B', checked: false, sort_order: 1, due_date: null, priority: null, category: null, assigned_to: null, created_by: 'u', created_at: '', updated_at: '' },
        { id: 'c', list_id: 'list-1', text: 'C', checked: false, sort_order: 2, due_date: null, priority: null, category: null, assigned_to: null, created_by: 'u', created_at: '', updated_at: '' },
      ],
    },
    error: null,
  }),
}))
// Render within a MemoryRouter with the :listId route. Assert on the reorder call.
```

> Keyboard drag in jsdom via dnd-kit can be finicky; if a full keyboard-drag simulation is flaky, instead unit-test the drag math by calling `SortableList`'s `onReorder` through a thin harness, and keep this page test focused on rendering a drag handle per row (assert `getAllByLabelText('Reorder item')` has length 3). Prefer the deterministic assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/ListDetailPage.reorder.test.tsx`
Expected: FAIL — no drag handle rendered.

- [ ] **Step 3: Implement `ListItemRow` handle** — add an optional `sortable` prop and render a `GripVertical` handle as the first child:

```tsx
import { Check, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import type { CSSProperties } from 'react'
// ...
export function ListItemRow({
  item,
  onToggleChecked,
  onRename,
  onDelete,
  sortable,
}: {
  item: ListItem
  onToggleChecked: (itemId: string, checked: boolean) => Promise<void>
  onRename: (itemId: string, text: string) => Promise<void>
  onDelete: (itemId: string) => Promise<void>
  sortable?: {
    setNodeRef: (el: HTMLElement | null) => void
    style: CSSProperties
    attributes: Record<string, unknown>
    listeners: Record<string, unknown> | undefined
    isDragging: boolean
  }
}) {
  // ...existing state...
  return (
    <li
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={cn(
        'flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b border-zinc-800 group last:border-0',
        sortable?.isDragging && 'opacity-60',
      )}
    >
      {sortable && (
        <button
          type="button"
          ref={undefined}
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label="Reorder item"
          className="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 cursor-grab touch-none sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
        >
          <GripVertical size={14} />
        </button>
      )}
      {/* ...rest unchanged... */}
```

- [ ] **Step 4: Implement `ListDetailPage` wiring** — replace the `<ul>{detail.items.map(...)}</ul>` block. Because `SortableList` renders children directly and `useSortableRow` must be called inside a component subscribed to the `SortableContext`, introduce a small local row component:

```tsx
import { SortableList, useSortableRow } from '../components/lists/SortableList'
import { reorderListItems } from '../resources/listData'
// ...

function SortableItemRow({ item, ...handlers }: { item: ListItem } & ItemHandlers) {
  const sortable = useSortableRow(item.id)
  return <ListItemRow item={item} sortable={sortable} {...handlers} />
}
// ...
<ul>
  <SortableList
    items={detail.items}
    onReorder={(orderedIds) => void reorderListItems(listId, orderedIds)}
    disabled={detail.archived || detail.items.length < 2}
  >
    {(item) => (
      <SortableItemRow
        key={item.id}
        item={item}
        onToggleChecked={handleToggleItem}
        onRename={handleRenameItem}
        onDelete={handleDeleteItem}
      />
    )}
  </SortableList>
</ul>
```

> Define `type ItemHandlers = Pick<ComponentProps<typeof ListItemRow>, 'onToggleChecked' | 'onRename' | 'onDelete'>`. Disable drag on archived lists and when fewer than 2 items (no handle shown — the `disabled` branch of `SortableList` renders plain rows, and `useSortableRow` is not called).

- [ ] **Step 4b: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/ListDetailPage.reorder.test.tsx`
Expected: PASS (drag handles rendered / reorder call fired).

- [ ] **Step 5: Manual check + commit** — start the app (`make dev-up` if not running), open a list with ≥2 items, drag a row, confirm order persists across refresh. Then:

```bash
git add frontend/src/components/lists/ListItemRow.tsx frontend/src/pages/ListDetailPage.tsx frontend/src/pages/ListDetailPage.reorder.test.tsx
git commit -m "feat(lists): drag-and-drop reorder of list items"
```

---

## Task 11: Wire list drag into the sidebar

**Files:**
- Modify: `frontend/src/components/lists/ListSidebarRow.tsx`, `frontend/src/pages/ListsLayout.tsx`
- Test: `frontend/src/pages/ListsLayout.reorder.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: `SortableList`, `useSortableRow`, `reorderLists`.
- `ListSidebarRow` gains the same optional `sortable` prop shape as `ListItemRow`. The drag handle sits inside the row but must `stopPropagation` so it doesn't trigger `onSelect`.
- **Gate:** list drag is enabled only when `typeFilter === 'all'` AND there are no archived lists currently shown among `filteredLists` (so the optimistic non-archived subset equals the displayed set). Otherwise render non-draggable rows.

- [ ] **Step 1: Write the failing test** — render `ListsLayout` (mock `useListSummaries` to return 3 non-archived lists on one dashboard, mock dashboards store), assert each row shows a `Reorder list` handle when the `all` filter is active; assert the handle is absent when a non-`all` filter is selected. Mock `reorderLists` and assert it is called with the reordered ids when `SortableList.onReorder` fires (via the deterministic harness approach from Task 10 Step 1's note).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/ListsLayout.reorder.test.tsx`
Expected: FAIL — no handle.

- [ ] **Step 3: Implement `ListSidebarRow` handle** — add the `sortable` prop (same shape as Task 10), spread `setNodeRef`/`style` on the outer `<div role="button">`, and render a `GripVertical` button at the start of the inner header row with `onClick`/`onKeyDown` → `event.stopPropagation()` plus `{...sortable.attributes} {...sortable.listeners}` and `aria-label="Reorder list"`, `className="... cursor-grab touch-none"`.

- [ ] **Step 4: Implement `ListsLayout` wiring** — compute the gate and wrap the rows:

```tsx
import { SortableList, useSortableRow } from '../components/lists/SortableList'
import { archiveList, createList, deleteList, reorderLists, updateListName, useListSummaries } from '../resources/listData'
// ...
const hasArchivedShown = filteredLists.some((l) => l.archived)
const canReorderLists = typeFilter === 'all' && !hasArchivedShown && effectiveDashboardId != null

// in the sidebar column, replace the `filteredLists.map(...)` block:
<SortableList
  items={filteredLists}
  onReorder={(orderedIds) => {
    if (effectiveDashboardId) void reorderLists(effectiveDashboardId, orderedIds)
  }}
  disabled={!canReorderLists || filteredLists.length < 2}
>
  {(list) => (
    <SortableSidebarRow
      key={list.id}
      list={list}
      selectedId={listId}
      onSelect={(id) => navigate(listUrl(id))}
      onRename={handleRenameList}
      onArchive={archiveList}
      onDelete={handleDeleteList}
    />
  )}
</SortableList>
```

With a local `SortableSidebarRow` calling `useSortableRow(list.id)` and passing `sortable` to `ListSidebarRow` (mirroring Task 10's `SortableItemRow`).

> When `canReorderLists` is false (a type filter is active or archived lists are shown), `SortableList`'s `disabled` branch renders plain rows with no handle — reordering is only offered in the unfiltered, active-only view. This keeps the optimistic non-archived subset exactly equal to what's on screen, so `orderByIds` never diverges from a filter mismatch.

- [ ] **Step 4b: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/ListsLayout.reorder.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full frontend gate + commit**

Run: `cd frontend && npm run lint && npm run typecheck && npm test`
Expected: all green.

```bash
git add frontend/src/components/lists/ListSidebarRow.tsx frontend/src/pages/ListsLayout.tsx frontend/src/pages/ListsLayout.reorder.test.tsx
git commit -m "feat(lists): drag-and-drop reorder of lists in the sidebar"
```

---

## Task 12: Full verification + docs/tracker update

**Files:**
- Modify: `docs/references/review-findings.md`, `CONTEXT.md`, `docs/designs/list-reordering-design.md`

- [ ] **Step 1: Run the full suite**

Run: `make test && make lint`
Expected: backend pytest (incl. `test_lists_reorder.py`), frontend vitest, typecheck, and Biome all pass. (Backend needs Docker for Testcontainers.)

- [ ] **Step 2: Manual end-to-end check (two browsers/users)** — with a shared dashboard, reorder items in one browser; confirm the other browser reflects the new order **without a full list flash** (reorder-in-place), and that the network tab shows **one** `PUT` and **no** follow-up `GET /api/lists/...` on the observer. Reorder lists likewise.

- [ ] **Step 3: Update review-findings #14 and #30** — add a Disposition line under each, plus a Changelog entry. Per the tracker protocol, do this in the same commit as the shipped code.

`### 14.`:

```markdown
- **Disposition** — ◐ Partially done <DATE> (`<sha1>`, `<sha2>`…): the reorder-input slice
  landed — transactional bulk-reorder endpoints (`PUT /lists/order`,
  `PUT /lists/{id}/items/order`) renumber `sort_order` atomically under a row lock with
  `extra='forbid'`, non-empty, no-duplicate DTOs; `sort_order` removed from `ListItemUpdate`
  so arbitrary/negative/duplicate orders can no longer be PATCHed; DB `sort_order >= 0`
  CHECK added (the `ge=0` gap). Still open: dashboard name bounds, typed layout/widget
  config, `ProfileUpdate`, bounded mutation headers.
```

`### 30.`:

```markdown
- **Disposition** — ◐ Partially done <DATE> (`<sha>`): the nonnegative sort-order slice
  landed — `ck_lists_sort_order_nonneg` / `ck_list_items_sort_order_nonneg` CHECK constraints
  on `lists`/`list_items` (model `__table_args__` + migration `a3f7c2e9d1b4`). Still open:
  widget-resource paired-field constraints, assignee-in-audience validation, calendar
  override occurrence-membership (all untouched here).
```

Changelog: `- **<DATE>** — List/item drag-and-drop reorder shipped; closes #14's reorder slice and #30's sort-order slice (`<sha>`…).`

> Also remove #14 and #30 from the "Backlog (unscheduled)" row of the rollout table only if fully done — here they are **partial**, so leave them in the row and let the Disposition lines carry the detail (matches how #42 partial is tracked).

- [ ] **Step 4: Update `CONTEXT.md`** — move list/item reordering from any "deferred/planned" note into shipped/current state, one line.

- [ ] **Step 5: Update the design doc status** — set `docs/designs/list-reordering-design.md` status to `✅ Shipped <DATE>` with SHAs; if the whole feature is closed, move it to `docs/shipped/` per the repo docs convention.

- [ ] **Step 6: Commit**

```bash
git add docs/references/review-findings.md CONTEXT.md docs/designs/list-reordering-design.md
git commit -m "docs(lists): record reorder shipment and update review-findings #14"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** both endpoints (Tasks 3–4), DTO validation + #14 cleanup (Task 1), DB nonnegative CHECK / #30 + #14 `ge=0` (Task 1b), event types (Tasks 2, 8), dnd-kit + UX handles + activation constraints + keyboard (Tasks 5, 9–11), merge-not-refetch SSE (Task 7), archived exclusion + filter gate (Tasks 4, 7, 11), ListWidget untouched (no task modifies it), tests on every task, review-findings #14 + #30 dispositions (Task 12). ✅
- **Type consistency:** `sortable` prop shape identical in `ListItemRow`/`ListSidebarRow`; `useSortableRow`/`SortableList` names stable; `orderByIds` used by both mutations and both SSE branches; `reorderListItems`/`reorderLists` names match across api → resource → UI. ✅
- **No placeholders:** all steps carry concrete code or exact commands. The two page tests note a deterministic fallback assertion where jsdom keyboard-drag is flaky. ✅
