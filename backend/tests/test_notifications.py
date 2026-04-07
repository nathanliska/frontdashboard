import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification
from tests.helpers import create_dashboard, create_list, create_list_item, current_user, set_csrf


async def test_notification_endpoints(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    user = await current_user(auth_client)
    user_id = uuid.UUID(user["id"])
    now = datetime.now(UTC)

    unread_newest = Notification(
        id=uuid.uuid4(),
        user_id=user_id,
        group_id=None,
        activity_event_id=None,
        type="membership.added",
        title="Newest unread",
        body="Body",
        reference_type="group",
        reference_id=uuid.uuid4(),
        read_at=None,
        created_at=now,
    )
    unread_older = Notification(
        id=uuid.uuid4(),
        user_id=user_id,
        group_id=None,
        activity_event_id=None,
        type="membership.added",
        title="Older unread",
        body="Body",
        reference_type="group",
        reference_id=uuid.uuid4(),
        read_at=None,
        created_at=now - timedelta(minutes=2),
    )
    already_read = Notification(
        id=uuid.uuid4(),
        user_id=user_id,
        group_id=None,
        activity_event_id=None,
        type="membership.removed",
        title="Already read",
        body="Body",
        reference_type="group",
        reference_id=uuid.uuid4(),
        read_at=now - timedelta(minutes=1),
        created_at=now - timedelta(minutes=1),
    )
    db_session.add_all([unread_newest, unread_older, already_read])
    await db_session.commit()

    list_resp = await auth_client.get("/api/notifications")
    assert list_resp.status_code == 200
    ids = [item["id"] for item in list_resp.json()]
    assert ids == [
        str(unread_newest.id),
        str(unread_older.id),
        str(already_read.id),
    ]

    unread_count = await auth_client.get("/api/notifications/unread-count")
    assert unread_count.status_code == 200
    assert unread_count.json() == {"count": 2}

    set_csrf(auth_client)
    mark_read = await auth_client.patch(f"/api/notifications/{unread_older.id}/read")
    assert mark_read.status_code == 200
    assert mark_read.json()["read_at"] is not None

    unread_count = await auth_client.get("/api/notifications/unread-count")
    assert unread_count.json() == {"count": 1}

    set_csrf(auth_client)
    mark_all = await auth_client.patch("/api/notifications/read-all")
    assert mark_all.status_code == 204

    unread_count = await auth_client.get("/api/notifications/unread-count")
    assert unread_count.json() == {"count": 0}

    list_resp = await auth_client.get("/api/notifications")
    assert list_resp.status_code == 200
    assert all(item["read_at"] is not None for item in list_resp.json())


async def test_mark_read_returns_404_for_missing_notification(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(f"/api/notifications/{uuid.uuid4()}/read")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Notification not found"


async def test_activity_endpoint_filters_and_paginates(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Activity Board")
    lst = await create_list(auth_client, dashboard["id"], name="Chores")
    await create_list_item(auth_client, lst["id"], text="Vacuum")

    activity_resp = await auth_client.get("/api/activity")
    assert activity_resp.status_code == 200
    events = activity_resp.json()
    assert [event["event_type"] for event in events[:2]] == [
        "list.item.created",
        "list.created",
    ]

    latest_event_id = events[0]["event_id"]
    before_resp = await auth_client.get("/api/activity", params={"before_event_id": latest_event_id})
    assert before_resp.status_code == 200
    assert [event["event_type"] for event in before_resp.json()] == ["list.created"]

    filter_resp = await auth_client.get("/api/activity", params={"event_type": "list.created"})
    assert filter_resp.status_code == 200
    assert [event["event_type"] for event in filter_resp.json()] == ["list.created"]
