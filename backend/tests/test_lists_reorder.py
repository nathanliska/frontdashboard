import uuid

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent, EventType
from app.models.list import List, ListItem
from app.schemas.lists import ItemReorder, ListReorder
from tests.helpers import (
    create_dashboard,
    create_list,
    create_list_item,
    register_client,
    set_csrf,
    share_dashboard,
)


def test_item_reorder_rejects_empty():
    with pytest.raises(ValidationError):
        ItemReorder(item_ids=[])


def test_item_reorder_rejects_duplicates():
    dup = uuid.uuid4()
    with pytest.raises(ValidationError):
        ItemReorder(item_ids=[dup, dup])


def test_item_reorder_rejects_extra_fields():
    with pytest.raises(ValidationError):
        # model_validate takes an untyped mapping, so the intentionally-unknown
        # field is rejected at runtime by extra="forbid" without tripping ty.
        ItemReorder.model_validate({"item_ids": [uuid.uuid4()], "sneaky": True})


def test_list_reorder_accepts_valid():
    dash = uuid.uuid4()
    ids = [uuid.uuid4(), uuid.uuid4()]
    model = ListReorder(dashboard_id=dash, list_ids=ids)
    assert model.list_ids == ids


async def test_negative_item_sort_order_rejected(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    owner_id = uuid.UUID(dashboard["user_id"])

    db_session.add(
        ListItem(
            list_id=uuid.UUID(lst["id"]),
            text="bad",
            sort_order=-1,
            created_by=owner_id,
            updated_by=owner_id,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_negative_list_sort_order_rejected(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client)
    owner_id = uuid.UUID(dashboard["user_id"])

    db_session.add(
        List(
            dashboard_id=uuid.UUID(dashboard["id"]),
            created_by=owner_id,
            updated_by=owner_id,
            name="Bad List",
            list_type="checklist",
            sort_order=-1,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.fixture
async def make_list_with_items(auth_client: AsyncClient):
    """Create a dashboard + list, then append items in order; returns (list_id, item_ids)."""

    async def _make(texts: list[str]) -> tuple[str, list[str]]:
        dashboard = await create_dashboard(auth_client)
        lst = await create_list(auth_client, dashboard["id"])
        item_ids = []
        for text in texts:
            item = await create_list_item(auth_client, lst["id"], text=text)
            item_ids.append(item["id"])
        return lst["id"], item_ids

    return _make


async def test_reorder_items_renumbers(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])
    reordered = [item_ids[2], item_ids[0], item_ids[1]]

    set_csrf(auth_client)
    res = await auth_client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": reordered})
    assert res.status_code == 204

    detail = (await auth_client.get(f"/api/lists/{list_id}")).json()
    assert [i["id"] for i in detail["items"]] == reordered
    assert [i["sort_order"] for i in detail["items"]] == [0, 1, 2]


async def test_reorder_items_rejects_mismatched_set(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b"])
    set_csrf(auth_client)
    res = await auth_client.put(
        f"/api/lists/{list_id}/items/order",
        json={"item_ids": [item_ids[0], str(uuid.uuid4())]},
    )
    assert res.status_code == 409


async def test_reorder_items_requires_all_ids(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])
    set_csrf(auth_client)
    res = await auth_client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": [item_ids[0]]})
    assert res.status_code == 409


@pytest.fixture
async def make_dashboard_with_lists(auth_client: AsyncClient):
    """Create a dashboard, then create lists in order; returns (dashboard_id, list_ids)."""

    async def _make(names: list[str]) -> tuple[str, list[str]]:
        dashboard = await create_dashboard(auth_client)
        list_ids = []
        for name in names:
            lst = await create_list(auth_client, dashboard["id"], name=name)
            list_ids.append(lst["id"])
        return dashboard["id"], list_ids

    return _make


async def test_reorder_lists_renumbers(
    auth_client: AsyncClient,
    make_dashboard_with_lists,
) -> None:
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2", "L3"])
    reordered = [list_ids[2], list_ids[1], list_ids[0]]

    set_csrf(auth_client)
    res = await auth_client.put("/api/lists/order", json={"dashboard_id": dash_id, "list_ids": reordered})
    assert res.status_code == 204

    lists = (await auth_client.get(f"/api/lists?dashboard_id={dash_id}")).json()
    assert [lst["id"] for lst in lists] == reordered
    assert [lst["sort_order"] for lst in lists] == [0, 1, 2]


async def test_reorder_lists_rejects_mismatched_set(
    auth_client: AsyncClient,
    make_dashboard_with_lists,
) -> None:
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2"])
    set_csrf(auth_client)
    res = await auth_client.put(
        "/api/lists/order",
        json={"dashboard_id": dash_id, "list_ids": [list_ids[0], str(uuid.uuid4())]},
    )
    assert res.status_code == 409


async def test_new_list_appends_last_after_reorder(
    auth_client: AsyncClient,
    make_dashboard_with_lists,
) -> None:
    """A list created after a reorder must append, not inherit sort_order=0.

    Inheriting it would place the list near the top by the created_at tiebreak.
    """
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2", "L3"])
    reordered = [list_ids[2], list_ids[0], list_ids[1]]

    set_csrf(auth_client)
    res = await auth_client.put("/api/lists/order", json={"dashboard_id": dash_id, "list_ids": reordered})
    assert res.status_code == 204

    new_list = await create_list(auth_client, dash_id, name="L4")

    lists = (await auth_client.get(f"/api/lists?dashboard_id={dash_id}")).json()
    assert lists[-1]["id"] == new_list["id"]
    assert lists[-1]["sort_order"] == max(lst["sort_order"] for lst in lists)
    assert lists[-1]["sort_order"] == 3


# ---------------------------------------------------------------------------
# Soft-deleted items excluded from PUT /lists/{id}/items/order
# ---------------------------------------------------------------------------


async def test_reorder_items_excludes_soft_deleted(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])
    deleted_id = item_ids[1]

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/lists/{list_id}/items/{deleted_id}")
    assert delete_resp.status_code == 204

    remaining = [item_ids[0], item_ids[2]]
    reordered = [remaining[1], remaining[0]]

    set_csrf(auth_client)
    res = await auth_client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": reordered})
    assert res.status_code == 204

    detail = (await auth_client.get(f"/api/lists/{list_id}")).json()
    assert [i["id"] for i in detail["items"]] == reordered
    assert deleted_id not in [i["id"] for i in detail["items"]]


async def test_reorder_items_rejects_submission_including_deleted(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])
    deleted_id = item_ids[1]

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/lists/{list_id}/items/{deleted_id}")
    assert delete_resp.status_code == 204

    set_csrf(auth_client)
    res = await auth_client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": item_ids})
    assert res.status_code == 409


# ---------------------------------------------------------------------------
# Exactly one activity event per reorder call
# ---------------------------------------------------------------------------


async def _reorder_event_count(db_session: AsyncSession, event_type: EventType) -> int:
    result = await db_session.execute(select(func.count(ActivityEvent.id)).where(ActivityEvent.event_type == event_type))
    return result.scalar_one()


async def test_reorder_lists_emits_exactly_one_event(
    auth_client: AsyncClient,
    make_dashboard_with_lists,
    db_session: AsyncSession,
) -> None:
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2", "L3"])
    reordered = [list_ids[2], list_ids[0], list_ids[1]]

    before = await _reorder_event_count(db_session, EventType.list_reordered)
    set_csrf(auth_client)
    res = await auth_client.put("/api/lists/order", json={"dashboard_id": dash_id, "list_ids": reordered})
    assert res.status_code == 204
    after = await _reorder_event_count(db_session, EventType.list_reordered)
    assert after - before == 1

    result = await db_session.execute(
        select(ActivityEvent).where(ActivityEvent.event_type == EventType.list_reordered).order_by(ActivityEvent.event_id.desc()).limit(1)
    )
    event = result.scalar_one()
    assert event.payload["list_ids"] == reordered
    assert event.payload["dashboard_name"] == "Test Board"


async def test_reorder_items_emits_exactly_one_event(
    auth_client: AsyncClient,
    make_list_with_items,
    db_session: AsyncSession,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b", "c"])
    reordered = [item_ids[2], item_ids[0], item_ids[1]]

    before = await _reorder_event_count(db_session, EventType.list_item_reordered)
    set_csrf(auth_client)
    res = await auth_client.put(f"/api/lists/{list_id}/items/order", json={"item_ids": reordered})
    assert res.status_code == 204
    after = await _reorder_event_count(db_session, EventType.list_item_reordered)
    assert after - before == 1

    result = await db_session.execute(
        select(ActivityEvent).where(ActivityEvent.event_type == EventType.list_item_reordered).order_by(ActivityEvent.event_id.desc()).limit(1)
    )
    event = result.scalar_one()
    assert event.payload["item_ids"] == reordered
    assert event.payload["list_name"] == "Shopping"


# ---------------------------------------------------------------------------
# Authz for both reorder endpoints
# ---------------------------------------------------------------------------


async def test_reorder_lists_requires_access(
    auth_client: AsyncClient,
    make_dashboard_with_lists,
) -> None:
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2"])

    other = await register_client("no-access-reorder-lists@example.com")
    try:
        set_csrf(other)
        res = await other.put("/api/lists/order", json={"dashboard_id": dash_id, "list_ids": list_ids})
        assert res.status_code == 404
    finally:
        await other.__aexit__(None, None, None)


async def test_reorder_lists_forbidden_for_viewer(
    auth_client: AsyncClient,
    make_dashboard_with_lists,
) -> None:
    dash_id, list_ids = await make_dashboard_with_lists(["L1", "L2"])

    viewer = await register_client("viewer-reorder-lists@example.com")
    try:
        await share_dashboard(auth_client, dash_id, viewer, "viewer")

        set_csrf(viewer)
        res = await viewer.put("/api/lists/order", json={"dashboard_id": dash_id, "list_ids": list_ids})
        assert res.status_code == 403
    finally:
        await viewer.__aexit__(None, None, None)


async def test_reorder_items_requires_access(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b"])

    other = await register_client("no-access-reorder-items@example.com")
    try:
        set_csrf(other)
        res = await other.put(f"/api/lists/{list_id}/items/order", json={"item_ids": item_ids})
        assert res.status_code == 404
    finally:
        await other.__aexit__(None, None, None)


async def test_reorder_items_forbidden_for_viewer(
    auth_client: AsyncClient,
    make_list_with_items,
) -> None:
    list_id, item_ids = await make_list_with_items(["a", "b"])

    # Find the dashboard that owns this list so we can share it as viewer.
    list_detail = (await auth_client.get(f"/api/lists/{list_id}")).json()
    dash_id = list_detail["dashboard_id"]

    viewer = await register_client("viewer-reorder-items@example.com")
    try:
        await share_dashboard(auth_client, dash_id, viewer, "viewer")

        set_csrf(viewer)
        res = await viewer.put(f"/api/lists/{list_id}/items/order", json={"item_ids": item_ids})
        assert res.status_code == 403
    finally:
        await viewer.__aexit__(None, None, None)
