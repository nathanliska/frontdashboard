# Dashboard Deletion Integrity (#2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make permanent dashboard deletion succeed and leave no orphans when the dashboard has soft-deleted lists or calendar events.

**Architecture:** Application-level fix. `delete_dashboard` currently selects child lists/events with a `deleted_at IS NULL` filter, so soft-deleted children survive and their non-cascading `dashboard_id` FK makes the final `DELETE FROM dashboards` raise `ForeignKeyViolation`. Remove the two filters so every child (and its items/overrides) is swept regardless of soft-delete state. No schema change, no migration.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 async, pytest + Testcontainers (`postgres:16-alpine`).

## Global Constraints

- Backend soft-delete is per-table and manual (`List`/`ListItem`/`CalendarEvent` carry `deleted_at`); `Dashboard`/`DashboardWidget` are hard-deleted. This fix does **not** change soft-delete semantics anywhere else — it only changes what *permanent dashboard deletion* sweeps.
- Do not alter the handler's deletion order, per-child `cleanup_resource_shares`, `_remove_dashboard_from_user_preferences`, or the build-event-before-commit / `broadcast`-after-commit choreography.
- No migration and no model change (deliberate — tests build schema from `create_all`, not migrations, so a model-level cascade would mask migration drift; see the spec's Decision).
- Conventional Commit messages, no attribution trailer. Confirm with the human before committing.

---

### Task 1: Sweep soft-deleted lists and events on permanent dashboard deletion

**Files:**
- Modify: `backend/app/routers/dashboards.py` (inside `delete_dashboard`, the two child-select statements — currently at lines 581 and 589)
- Test: `backend/tests/test_dashboards.py` (add one regression test; extend the existing `tests.helpers` and model imports)

**Interfaces:**
- Consumes: existing helpers `create_dashboard`, `create_list`, `create_list_item`, `create_calendar_event`, `set_csrf` from `tests.helpers`; the `auth_client` and `db_session` fixtures from `tests/conftest.py` (the `client` fixture overrides `get_db` to yield the *same* `db_session`, so writes flushed via `db_session` are visible to the route, and rows the route commits are visible to a later `db_session` query — this is the pattern in `test_profile_update_bumps_session_last_used_at`).
- Produces: no new public interface; behavior change only.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_dashboards.py`. First extend the two existing import lines at the top of the file:

```python
import uuid
from datetime import UTC, datetime
```

Add `create_list_item` to the existing helpers import so it reads:

```python
from tests.helpers import (
    create_calendar_event,
    create_dashboard,
    create_list,
    create_list_item,
    current_user,
    register_client,
    set_csrf,
)
```

Add the model imports the assertions need (the file currently imports only `ActivityEvent`):

```python
from app.models.calendar import CalendarEvent
from app.models.dashboard import Dashboard
from app.models.list import List, ListItem
```

Then add the test:

```python
async def test_delete_dashboard_sweeps_soft_deleted_children(
    auth_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A dashboard with soft-deleted lists/events must still delete cleanly.

    The child FKs to dashboards.id have no ON DELETE cascade, so a soft-deleted
    list or event left behind makes the final DELETE FROM dashboards raise a
    ForeignKeyViolation (500). Deletion must sweep children regardless of
    soft-delete state — including items under a soft-deleted list.
    """
    dashboard = await create_dashboard(auth_client, name="Has Deleted Children")
    lst = await create_list(auth_client, dashboard["id"], name="Old List")
    item = await create_list_item(auth_client, lst["id"], text="stale")
    event = await create_calendar_event(auth_client, dashboard["id"], title="Old Event")

    # Soft-delete the list and event directly. This leaves the item in place under
    # the soft-deleted list — the exact orphan hazard the fix must sweep.
    now = datetime.now(UTC)
    db_list = (
        await db_session.execute(select(List).where(List.id == uuid.UUID(lst["id"])))
    ).scalar_one()
    db_list.deleted_at = now
    db_event = (
        await db_session.execute(
            select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"]))
        )
    ).scalar_one()
    db_event.deleted_at = now
    await db_session.flush()

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert delete_resp.status_code == 204

    # No rows remain for the dashboard — parent, both children, and the item.
    assert (
        await db_session.execute(
            select(Dashboard).where(Dashboard.id == uuid.UUID(dashboard["id"]))
        )
    ).scalar_one_or_none() is None
    assert (
        await db_session.execute(select(List).where(List.id == uuid.UUID(lst["id"])))
    ).scalar_one_or_none() is None
    assert (
        await db_session.execute(
            select(ListItem).where(ListItem.id == uuid.UUID(item["id"]))
        )
    ).scalar_one_or_none() is None
    assert (
        await db_session.execute(
            select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"]))
        )
    ).scalar_one_or_none() is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_dashboards.py::test_delete_dashboard_sweeps_soft_deleted_children -v`
Expected: FAIL. The `DELETE /api/dashboards/{id}` returns a 500 (server-side `ForeignKeyViolation` on the final dashboard delete because the soft-deleted `lists`/`calendar_events` rows still reference it), so `assert delete_resp.status_code == 204` fails.

- [ ] **Step 3: Make the minimal fix**

In `backend/app/routers/dashboards.py`, inside `delete_dashboard`, drop the `deleted_at` filter from both child selects so soft-deleted children are swept too.

Change the list select from:

```python
    list_result = await db.execute(select(List.id).where(List.dashboard_id == dashboard.id, List.deleted_at.is_(None)))
```

to:

```python
    # Sweep ALL child lists, including soft-deleted ones: their dashboard_id FK
    # has no ON DELETE cascade, so a leftover soft-deleted row would block this
    # dashboard's delete. Do not re-add a deleted_at filter here.
    list_result = await db.execute(select(List.id).where(List.dashboard_id == dashboard.id))
```

Change the event select from:

```python
    event_result = await db.execute(select(CalendarEvent.id).where(CalendarEvent.dashboard_id == dashboard.id, CalendarEvent.deleted_at.is_(None)))
```

to:

```python
    # Same as lists above — sweep soft-deleted events too (no FK cascade).
    event_result = await db.execute(select(CalendarEvent.id).where(CalendarEvent.dashboard_id == dashboard.id))
```

Leave everything else in the handler unchanged (the item pre-delete `delete(ListItem).where(ListItem.list_id.in_(list_ids))` already sweeps items of the now-included soft-deleted lists; event overrides/reminders cascade).

- [ ] **Step 4: Run the new test and the existing delete tests to verify they pass**

Run: `uv run pytest tests/test_dashboards.py -v`
Expected: PASS — the new test plus the existing `test_delete_archived_dashboard_removes_dashboard_owned_lists_and_events`, `test_dashboard_calendar_routes_and_delete`, and `test_delete_dashboard_clears_dashboard_preferences` (active-child path, unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/dashboards.py backend/tests/test_dashboards.py
git commit -m "fix(dashboards): delete soft-deleted child lists/events with the dashboard (#2)"
```

---

## Self-Review

- **Spec coverage:** The spec's single change (drop both `deleted_at IS NULL` filters) and its single regression test are both in Task 1. The spec's "why complete" (only `lists`/`calendar_events` lack cascade, both now swept) is exercised by the test asserting all four row types are gone.
- **Placeholder scan:** none — all test and fix code is literal.
- **Type consistency:** test compares UUID columns via `uuid.UUID(...)` against the string ids returned in JSON; `db_session`/`auth_client` share one session so flushed writes and committed deletes are mutually visible (matches `test_profile_update_bumps_session_last_used_at`).
