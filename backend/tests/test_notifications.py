import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification
from tests.helpers import (
    create_dashboard,
    create_list,
    create_list_item,
    current_user,
    register_client,
    set_csrf,
    share_dashboard,
)


async def test_notification_endpoints(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    user = await current_user(auth_client)
    user_id = uuid.UUID(user["id"])
    now = datetime.now(UTC)

    unread_newest = Notification(
        id=uuid.uuid4(),
        user_id=user_id,
        activity_event_id=None,
        type="dashboard.share_added",
        title="Newest unread",
        body="Body",
        reference_type="dashboard",
        reference_id=uuid.uuid4(),
        read_at=None,
        created_at=now,
    )
    unread_older = Notification(
        id=uuid.uuid4(),
        user_id=user_id,
        activity_event_id=None,
        type="dashboard.share_updated",
        title="Older unread",
        body="Body",
        reference_type="dashboard",
        reference_id=uuid.uuid4(),
        read_at=None,
        created_at=now - timedelta(minutes=2),
    )
    already_read = Notification(
        id=uuid.uuid4(),
        user_id=user_id,
        activity_event_id=None,
        type="dashboard.share_removed",
        title="Already read",
        body="Body",
        reference_type="dashboard",
        reference_id=uuid.uuid4(),
        read_at=now - timedelta(minutes=1),
        created_at=now - timedelta(minutes=1),
    )
    db_session.add_all([unread_newest, unread_older, already_read])
    await db_session.commit()

    list_resp = await auth_client.get("/api/notifications")
    assert list_resp.status_code == 200
    assert list_resp.json()["next_cursor"] is None
    ids = [item["id"] for item in list_resp.json()["items"]]
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
    assert all(item["read_at"] is not None for item in list_resp.json()["items"])


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
    assert [event["event_type"] for event in before_resp.json()] == [
        "list.created",
        "dashboard.created",
    ]

    filter_resp = await auth_client.get("/api/activity", params={"event_type": "list.created"})
    assert filter_resp.status_code == 200
    assert [event["event_type"] for event in filter_resp.json()] == ["list.created"]


async def test_dashboard_share_notifications_and_activity_filtering(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client, name="Activity Notification Board")

    viewer = await register_client("dashboard-notified@example.com", display_name="Viewer")
    try:
        viewer_user = await current_user(viewer)
        await share_dashboard(auth_client, dashboard["id"], viewer, "viewer")
        (share,) = (await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")).json()
        share_id = share["id"]

        set_csrf(auth_client)
        update_share_resp = await auth_client.patch(
            f"/api/dashboards/{dashboard['id']}/shares/{share_id}",
            json={"role": "editor"},
        )
        assert update_share_resp.status_code == 200

        set_csrf(auth_client)
        delete_share_resp = await auth_client.delete(
            f"/api/dashboards/{dashboard['id']}/shares/{share_id}",
        )
        assert delete_share_resp.status_code == 204

        # Joining is the viewer's own act, so no "shared with you" notification exists any more —
        # they hear only about changes done *to* them afterwards.
        notification_resp = await viewer.get("/api/notifications")
        assert notification_resp.status_code == 200
        notifications = notification_resp.json()["items"]
        assert [notification["type"] for notification in notifications] == [
            "dashboard.share_removed",
            "dashboard.share_updated",
        ]
        notifications_by_type = {notification["type"]: notification["title"] for notification in notifications}
        assert notifications_by_type["dashboard.share_removed"] == "Dashboard access removed"
        assert notifications_by_type["dashboard.share_updated"] == "Dashboard access updated"

        unread_count_resp = await viewer.get("/api/notifications/unread-count")
        assert unread_count_resp.status_code == 200
        assert unread_count_resp.json() == {"count": 2}

        # The owner is the one told about the join, since the joiner acted for themselves.
        owner_notifications = await auth_client.get("/api/notifications")
        assert owner_notifications.status_code == 200
        owner_items = owner_notifications.json()["items"]
        assert [n["type"] for n in owner_items] == ["dashboard.share_added"]
        assert owner_items[0]["title"] == "Someone joined a dashboard"

        lst = await create_list(auth_client, dashboard["id"], name="Chores")
        item = await create_list_item(auth_client, lst["id"], text="Vacuum")

        set_csrf(auth_client)
        check_resp = await auth_client.patch(
            f"/api/lists/{lst['id']}/items/{item['id']}",
            json={"checked": True},
        )
        assert check_resp.status_code == 200

        set_csrf(auth_client)
        rename_resp = await auth_client.patch(
            f"/api/dashboards/{dashboard['id']}",
            json={"name": "Renamed Activity Notification Board"},
        )
        assert rename_resp.status_code == 200

        set_csrf(auth_client)
        layout_resp = await auth_client.put(
            f"/api/dashboards/{dashboard['id']}/layout",
            json={"layout": [], "version": rename_resp.json()["version"]},
        )
        assert layout_resp.status_code == 200

        activity_resp = await auth_client.get("/api/activity")
        assert activity_resp.status_code == 200
        activity = activity_resp.json()
        event_types = [event["event_type"] for event in activity]
        # share_added lives in the joiner's feed now — the viewer was its actor, not the owner.
        assert "dashboard.share_added" not in event_types
        assert "dashboard.share_updated" in event_types
        assert "dashboard.share_removed" in event_types
        viewer_event_types = [event["event_type"] for event in (await viewer.get("/api/activity")).json()]
        assert "dashboard.share_added" in viewer_event_types
        assert "list.created" in event_types
        assert "list.item.created" in event_types
        dashboard_updates = [event for event in activity if event["event_type"] == "dashboard.updated"]
        assert [event["payload"]["changed_fields"] for event in dashboard_updates] == [["layout"], ["name"]]
        # Served like everything else; the client collapses the run rather than the endpoint hiding it.
        assert "list.item.checked" in event_types

        notification_rows = (
            (await db_session.execute(select(Notification).where(Notification.user_id == uuid.UUID(viewer_user["id"])))).scalars().all()
        )
        assert len(notification_rows) == 2
    finally:
        await viewer.__aexit__(None, None, None)


async def test_notification_pages_walk_the_full_history_without_loss(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """The cursor walks unread-first ordering across pages, exactly once per row.

    The page limit is 50, so 120 rows (60 unread, 60 read, interleaved timestamps) force the
    cursor across the unread/read section boundary mid-page and across created_at ties.
    """
    me = await current_user(auth_client)
    now = datetime.now(UTC)
    rows = []
    for index in range(120):
        rows.append(
            Notification(
                user_id=uuid.UUID(me["id"]),
                type="list.item.created",
                title=f"n{index}",
                body="b",
                # Pairs share a timestamp so the id tiebreaker actually gets exercised.
                created_at=now - timedelta(minutes=index // 2),
                read_at=None if index % 2 == 0 else now,
            )
        )
    db_session.add_all(rows)
    await db_session.commit()

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params = {"cursor": cursor} if cursor else {}
        resp = await auth_client.get("/api/notifications", params=params)
        assert resp.status_code == 200
        body = resp.json()
        seen.extend(item["id"] for item in body["items"])
        pages += 1
        if body["next_cursor"] is None:
            break
        cursor = body["next_cursor"]
        assert pages < 10, "cursor did not terminate"

    assert len(seen) == 120
    assert len(set(seen)) == 120, "a row was repeated across pages"
    assert pages == 3  # 50 + 50 + 20

    # Section order holds across the whole walk: every unread row precedes every read row.
    read_flags = [next(r for r in rows if str(r.id) == seen_id).read_at is not None for seen_id in seen]
    first_read = read_flags.index(True)
    assert all(read_flags[first_read:]), "an unread row appeared after the read section began"


async def test_notification_cursor_rejects_garbage(auth_client: AsyncClient) -> None:
    resp = await auth_client.get("/api/notifications", params={"cursor": "not-a-cursor"})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Invalid cursor"
