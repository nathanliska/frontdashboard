import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from app.models.calendar import CalendarEvent
from app.models.dashboard import Dashboard
from app.models.list import List, ListItem
from app.models.user import User
from tests.helpers import (
    create_calendar_event,
    create_dashboard,
    create_list,
    create_list_item,
    current_user,
    register_client,
    set_csrf,
)


async def test_default_dashboard_listing_and_shared_access(auth_client: AsyncClient) -> None:
    me = await auth_client.get("/api/auth/me")
    assert me.status_code == 200
    home_dashboard_id = me.json()["preferences"]["home_dashboard_id"]

    default_resp = await auth_client.get("/api/dashboards/default")
    assert default_resp.status_code == 200
    default_dashboard = default_resp.json()
    assert default_dashboard["id"] == home_dashboard_id
    assert default_dashboard["widgets"] == []
    assert default_dashboard["layout"] == []

    owned_dashboard = await create_dashboard(auth_client, name="Projects")
    owned_detail = await auth_client.get(f"/api/dashboards/{owned_dashboard['id']}")
    assert owned_detail.status_code == 200
    assert owned_detail.json()["name"] == "Projects"

    owner = await register_client("dashboard-owner@example.com", display_name="Owner")
    try:
        shared_dashboard = await create_dashboard(owner, name="Shared Board")
        owner_user = await current_user(auth_client)

        set_csrf(owner)
        share_resp = await owner.post(
            f"/api/dashboards/{shared_dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": owner_user["id"], "role": "viewer"},
        )
        assert share_resp.status_code == 201

        list_resp = await auth_client.get("/api/dashboards")
        assert list_resp.status_code == 200
        dashboards = {item["id"]: item for item in list_resp.json()}
        assert owned_dashboard["id"] in dashboards
        assert dashboards[owned_dashboard["id"]]["access_description"] == "Owned by you"
        assert dashboards[owned_dashboard["id"]]["can_edit"] is True
        assert dashboards[owned_dashboard["id"]]["can_manage_shares"] is True
        assert dashboards[shared_dashboard["id"]]["access_description"] == "Shared directly with you"
        assert dashboards[shared_dashboard["id"]]["is_shared"] is True
        assert dashboards[shared_dashboard["id"]]["can_edit"] is False
        assert dashboards[shared_dashboard["id"]]["can_manage_shares"] is False

        shared_detail = await auth_client.get(f"/api/dashboards/{shared_dashboard['id']}")
        assert shared_detail.status_code == 200
        assert shared_detail.json()["can_edit"] is False
        assert shared_detail.json()["can_manage_shares"] is False
    finally:
        await owner.__aexit__(None, None, None)


async def test_dashboard_share_targets_must_be_active_verified_users(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client)
    owner = await current_user(auth_client)
    unverified = User(email="unverified-share@example.com", password_hash="x", display_name="Unverified")
    deleted = User(
        email="deleted-share@example.com",
        password_hash="x",
        display_name="Deleted",
        email_verified_at=datetime.now(UTC),
        deleted_at=datetime.now(UTC),
    )
    db_session.add_all([unverified, deleted])
    await db_session.flush()

    for target_id in (owner["id"], str(uuid.uuid4()), str(unverified.id), str(deleted.id)):
        set_csrf(auth_client)
        response = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": target_id, "role": "viewer"},
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "Share targets must be active verified users other than the owner"


async def test_dashboard_initial_shares_validate_targets(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    response = await auth_client.post(
        "/api/dashboards",
        json={
            "name": "Invalid Shared Board",
            "shares": [
                {
                    "principal_type": "user",
                    "principal_id": str(uuid.uuid4()),
                    "role": "viewer",
                }
            ],
        },
    )

    assert response.status_code == 422


async def test_dashboard_initial_shares_reject_duplicate_targets(auth_client: AsyncClient) -> None:
    target_id = str(uuid.uuid4())
    set_csrf(auth_client)
    response = await auth_client.post(
        "/api/dashboards",
        json={
            "name": "Duplicate Shares",
            "shares": [
                {"principal_type": "user", "principal_id": target_id, "role": "viewer"},
                {"principal_type": "user", "principal_id": target_id, "role": "editor"},
            ],
        },
    )

    assert response.status_code == 422
    assert "Duplicate share targets are not allowed" in str(response.json()["detail"])


async def test_update_dashboard_meta_and_layout(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Planning")

    set_csrf(auth_client)
    meta_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"name": "Renamed"},
    )
    assert meta_resp.status_code == 200
    meta = meta_resp.json()
    assert meta["name"] == "Renamed"
    assert meta["is_favorite"] is False
    assert meta["version"] == 0

    layout = [{"i": "sample-widget", "x": 0, "y": 0, "w": 4, "h": 3}]
    set_csrf(auth_client)
    layout_resp = await auth_client.put(
        f"/api/dashboards/{dashboard['id']}/layout",
        json={"layout": layout, "version": 0},
    )
    assert layout_resp.status_code == 200
    assert layout_resp.json()["layout"] == layout
    assert layout_resp.json()["version"] == 1

    set_csrf(auth_client)
    conflict_resp = await auth_client.put(
        f"/api/dashboards/{dashboard['id']}/layout",
        json={"layout": layout, "version": 0},
    )
    assert conflict_resp.status_code == 409
    assert "Version conflict" in conflict_resp.json()["detail"]


async def test_dashboard_names_are_trimmed_and_bounded(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    created = await auth_client.post("/api/dashboards", json={"name": "  Planning  "})
    assert created.status_code == 201
    assert created.json()["name"] == "Planning"

    dashboard_id = created.json()["id"]
    set_csrf(auth_client)
    renamed = await auth_client.patch(f"/api/dashboards/{dashboard_id}", json={"name": "  Renamed  "})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed"

    set_csrf(auth_client)
    assert (await auth_client.post("/api/dashboards", json={"name": "   "})).status_code == 422
    assert (await auth_client.post("/api/dashboards", json={"name": "x" * 101})).status_code == 422
    assert (await auth_client.patch(f"/api/dashboards/{dashboard_id}", json={"name": None})).status_code == 422


async def test_client_mutation_id_header_is_bounded(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    set_csrf(auth_client)
    resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"name": "Renamed"},
        headers={"X-Client-Mutation-Id": "x" * 129},
    )

    assert resp.status_code == 422


async def test_archive_dashboard_hides_and_restores_lists_and_events(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Archive Me")
    lst = await create_list(auth_client, dashboard["id"], name="Errands")
    event = await create_calendar_event(auth_client, dashboard["id"], title="Launch Review")

    set_csrf(auth_client)
    archive_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"archived": True},
    )
    assert archive_resp.status_code == 200
    assert archive_resp.json()["archived"] is True

    dashboards_resp = await auth_client.get("/api/dashboards")
    assert dashboards_resp.status_code == 200
    archived_dashboard = next(item for item in dashboards_resp.json() if item["id"] == dashboard["id"])
    assert archived_dashboard["archived"] is True

    dashboard_detail = await auth_client.get(f"/api/dashboards/{dashboard['id']}")
    assert dashboard_detail.status_code == 200
    assert dashboard_detail.json()["archived"] is True

    lists_resp = await auth_client.get("/api/lists", params={"dashboard_id": dashboard["id"]})
    assert lists_resp.status_code == 404

    list_detail = await auth_client.get(f"/api/lists/{lst['id']}")
    assert list_detail.status_code == 404

    calendar_resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert calendar_resp.status_code == 404

    event_detail = await auth_client.get(f"/api/calendar/events/{event['id']}")
    assert event_detail.status_code == 404

    set_csrf(auth_client)
    restore_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"archived": False},
    )
    assert restore_resp.status_code == 200
    assert restore_resp.json()["archived"] is False

    restored_lists = await auth_client.get("/api/lists", params={"dashboard_id": dashboard["id"]})
    assert restored_lists.status_code == 200
    assert [item["id"] for item in restored_lists.json()] == [lst["id"]]

    restored_calendar = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert restored_calendar.status_code == 200
    assert [item["event_id"] for item in restored_calendar.json()] == [event["id"]]


async def test_delete_archived_dashboard_removes_dashboard_owned_lists_and_events(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Archive Then Delete")
    lst = await create_list(auth_client, dashboard["id"], name="Packing")
    event = await create_calendar_event(auth_client, dashboard["id"], title="Flight")

    set_csrf(auth_client)
    archive_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"archived": True},
    )
    assert archive_resp.status_code == 200
    assert archive_resp.json()["archived"] is True

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert delete_resp.status_code == 204

    dashboard_resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}")
    assert dashboard_resp.status_code == 404

    list_resp = await auth_client.get(f"/api/lists/{lst['id']}")
    assert list_resp.status_code == 404

    event_resp = await auth_client.get(f"/api/calendar/events/{event['id']}")
    assert event_resp.status_code == 404


async def test_delete_dashboard_sweeps_soft_deleted_children(auth_client: AsyncClient, db_session: AsyncSession) -> None:
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
    db_list = (await db_session.execute(select(List).where(List.id == uuid.UUID(lst["id"])))).scalar_one()
    db_list.deleted_at = now
    db_event = (await db_session.execute(select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"])))).scalar_one()
    db_event.deleted_at = now
    await db_session.flush()

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert delete_resp.status_code == 204

    # No rows remain for the dashboard — parent, both children, and the item.
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == uuid.UUID(dashboard["id"])))).scalar_one_or_none() is None
    assert (await db_session.execute(select(List).where(List.id == uuid.UUID(lst["id"])))).scalar_one_or_none() is None
    assert (await db_session.execute(select(ListItem).where(ListItem.id == uuid.UUID(item["id"])))).scalar_one_or_none() is None
    assert (await db_session.execute(select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"])))).scalar_one_or_none() is None


async def test_update_dashboard_meta_rejects_legacy_favorite_field(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Legacy Favorite")

    set_csrf(auth_client)
    resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"is_favorite": True},
    )
    assert resp.status_code == 422


async def test_dashboard_favorites_are_per_user_preferences(auth_client: AsyncClient) -> None:
    shared_user = await register_client("favorite-viewer@example.com", display_name="Viewer")
    try:
        dashboard = await create_dashboard(auth_client, name="Shared Favorite")

        shared_user_me = await current_user(shared_user)
        set_csrf(auth_client)
        share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": shared_user_me["id"], "role": "viewer"},
        )
        assert share_resp.status_code == 201

        shared_dashboards_resp = await shared_user.get("/api/dashboards")
        assert shared_dashboards_resp.status_code == 200
        shared_dashboard = next(item for item in shared_dashboards_resp.json() if item["id"] == dashboard["id"])
        assert shared_dashboard["is_favorite"] is False

        set_csrf(shared_user)
        viewer_favorite_resp = await shared_user.patch(
            "/api/auth/preferences",
            json={"favorite_dashboard_ids": [dashboard["id"]]},
        )
        assert viewer_favorite_resp.status_code == 200
        assert viewer_favorite_resp.json()["preferences"]["favorite_dashboard_ids"] == [dashboard["id"]]

        shared_dashboards_resp = await shared_user.get("/api/dashboards")
        assert shared_dashboards_resp.status_code == 200
        shared_dashboard = next(item for item in shared_dashboards_resp.json() if item["id"] == dashboard["id"])
        assert shared_dashboard["is_favorite"] is True

        shared_detail_resp = await shared_user.get(f"/api/dashboards/{dashboard['id']}")
        assert shared_detail_resp.status_code == 200
        assert shared_detail_resp.json()["is_favorite"] is True

        owner_dashboards_resp = await auth_client.get("/api/dashboards")
        assert owner_dashboards_resp.status_code == 200
        owner_dashboard = next(item for item in owner_dashboards_resp.json() if item["id"] == dashboard["id"])
        assert owner_dashboard["is_favorite"] is False
    finally:
        await shared_user.__aexit__(None, None, None)


async def test_widget_lifecycle_creates_list_resource(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Widgets")

    set_csrf(auth_client)
    add_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/widgets",
        json={"widget_type": "list", "config": {"name": "Errands", "list_type": "todo"}},
    )
    assert add_resp.status_code == 201
    payload = add_resp.json()
    assert payload["version"] == 1
    assert len(payload["widgets"]) == 1
    widget = payload["widgets"][0]
    assert widget["widget_type"] == "list"
    assert widget["resource_type"] == "list"
    assert widget["resource_id"] is not None
    assert payload["layout"][0]["i"] == widget["id"]

    list_resp = await auth_client.get(f"/api/lists/{widget['resource_id']}")
    assert list_resp.status_code == 200
    assert list_resp.json()["name"] == "Errands"

    set_csrf(auth_client)
    update_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}/widgets/{widget['id']}",
        json={"config": {"title": "Pinned Errands"}},
    )
    assert update_resp.status_code == 200
    # The list widget's response config now has typed (optional) `list_name` /
    # `list_type` keys; a PATCH that fully replaces the stored config with
    # `{"title": ...}` (no list_name/list_type) round-trips those as null while
    # `title` still survives via `extra="allow"`.
    assert update_resp.json()["config"] == {
        "title": "Pinned Errands",
        "list_name": None,
        "list_type": None,
    }

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/widgets/{widget['id']}")
    assert delete_resp.status_code == 204

    detail_resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["widgets"] == []
    assert detail_resp.json()["layout"] == []


async def test_widget_created_list_appends_last_after_reorder(auth_client: AsyncClient) -> None:
    """A list created via the add-widget 'new list' path must append after
    existing lists (same append-order bug already fixed for POST /lists) —
    not inherit sort_order=0, which would tie it for first place."""
    dashboard = await create_dashboard(auth_client, name="Widgets")
    lst1 = await create_list(auth_client, dashboard["id"], name="L1")
    lst2 = await create_list(auth_client, dashboard["id"], name="L2")

    set_csrf(auth_client)
    reorder_resp = await auth_client.put(
        "/api/lists/order",
        json={"dashboard_id": dashboard["id"], "list_ids": [lst2["id"], lst1["id"]]},
    )
    assert reorder_resp.status_code == 204

    set_csrf(auth_client)
    add_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/widgets",
        json={"widget_type": "list", "config": {"name": "Errands", "list_type": "todo"}},
    )
    assert add_resp.status_code == 201
    widget = add_resp.json()["widgets"][0]

    lists = (await auth_client.get(f"/api/lists?dashboard_id={dashboard['id']}")).json()
    assert lists[-1]["id"] == widget["resource_id"]
    assert lists[-1]["sort_order"] == max(item["sort_order"] for item in lists)
    assert lists[-1]["sort_order"] == 2


async def test_calendar_widget_uses_small_default_layout(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Calendar Widgets")

    set_csrf(auth_client)
    add_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/widgets",
        json={"widget_type": "calendar", "config": {"view": "month"}},
    )
    assert add_resp.status_code == 201

    layout_item = add_resp.json()["layout"][0]
    assert layout_item["w"] == 3
    assert layout_item["h"] == 3


async def test_dashboard_calendar_routes_and_delete(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Calendar Dashboard")

    set_csrf(auth_client)
    create_resp = await auth_client.post(
        "/api/calendar/events",
        json={
            "dashboard_id": dashboard["id"],
            "title": "Launch Review",
            "starts_at": "2026-04-10T14:00:00+00:00",
            "ends_at": "2026-04-10T15:00:00+00:00",
            "timezone": "UTC",
            "all_day": False,
        },
    )
    assert create_resp.status_code == 201
    assert create_resp.json()["title"] == "Launch Review"

    occurrences_resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "dashboard_id": dashboard["id"],
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
        },
    )
    assert occurrences_resp.status_code == 200
    assert len(occurrences_resp.json()) == 1
    assert occurrences_resp.json()[0]["title"] == "Launch Review"

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert delete_resp.status_code == 204

    get_resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}")
    assert get_resp.status_code == 404


async def test_delete_dashboard_clears_dashboard_preferences(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Temporary Home")

    set_csrf(auth_client)
    owner_pref_resp = await auth_client.patch(
        "/api/auth/preferences",
        json={"home_dashboard_id": dashboard["id"], "favorite_dashboard_ids": [dashboard["id"]]},
    )
    assert owner_pref_resp.status_code == 200
    assert owner_pref_resp.json()["preferences"]["home_dashboard_id"] == dashboard["id"]
    assert owner_pref_resp.json()["preferences"]["favorite_dashboard_ids"] == [dashboard["id"]]

    shared_user = await register_client("dashboard-shared@example.com", display_name="Shared User")
    try:
        shared_user_me = await current_user(shared_user)

        set_csrf(auth_client)
        share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": shared_user_me["id"], "role": "viewer"},
        )
        assert share_resp.status_code == 201

        set_csrf(shared_user)
        shared_pref_resp = await shared_user.patch(
            "/api/auth/preferences",
            json={"home_dashboard_id": dashboard["id"], "favorite_dashboard_ids": [dashboard["id"]]},
        )
        assert shared_pref_resp.status_code == 200
        assert shared_pref_resp.json()["preferences"]["home_dashboard_id"] == dashboard["id"]
        assert shared_pref_resp.json()["preferences"]["favorite_dashboard_ids"] == [dashboard["id"]]

        set_csrf(auth_client)
        delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
        assert delete_resp.status_code == 204

        owner_me_resp = await auth_client.get("/api/auth/me")
        assert owner_me_resp.status_code == 200
        assert owner_me_resp.json()["preferences"]["home_dashboard_id"] is None
        assert owner_me_resp.json()["preferences"]["favorite_dashboard_ids"] == []

        shared_me_resp = await shared_user.get("/api/auth/me")
        assert shared_me_resp.status_code == 200
        assert shared_me_resp.json()["preferences"]["home_dashboard_id"] is None
        assert shared_me_resp.json()["preferences"]["favorite_dashboard_ids"] == []
    finally:
        await shared_user.__aexit__(None, None, None)


async def test_removing_dashboard_share_clears_removed_users_preferences(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Shared Temporary Favorite")

    shared_user = await register_client("dashboard-share-cleanup@example.com", display_name="Cleanup User")
    try:
        shared_user_me = await current_user(shared_user)

        set_csrf(auth_client)
        share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": shared_user_me["id"], "role": "viewer"},
        )
        assert share_resp.status_code == 201
        share_id = share_resp.json()["id"]

        set_csrf(shared_user)
        shared_pref_resp = await shared_user.patch(
            "/api/auth/preferences",
            json={"home_dashboard_id": dashboard["id"], "favorite_dashboard_ids": [dashboard["id"]]},
        )
        assert shared_pref_resp.status_code == 200

        set_csrf(auth_client)
        delete_share_resp = await auth_client.delete(
            f"/api/dashboards/{dashboard['id']}/shares/{share_id}",
        )
        assert delete_share_resp.status_code == 204

        shared_me_resp = await shared_user.get("/api/auth/me")
        assert shared_me_resp.status_code == 200
        assert shared_me_resp.json()["preferences"]["home_dashboard_id"] is None
        assert shared_me_resp.json()["preferences"]["favorite_dashboard_ids"] == []
    finally:
        await shared_user.__aexit__(None, None, None)


async def test_dashboard_share_mutations_emit_activity_events(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client, name="Shared Activity Board")

    shared_user = await register_client("dashboard-share-events@example.com", display_name="Shared User")
    try:
        shared_user_me = await current_user(shared_user)

        set_csrf(auth_client)
        add_share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": shared_user_me["id"], "role": "viewer"},
        )
        assert add_share_resp.status_code == 201
        share_id = add_share_resp.json()["id"]

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

        result = await db_session.execute(
            select(ActivityEvent)
            .where(
                ActivityEvent.entity_type == "dashboard",
                ActivityEvent.entity_id == dashboard["id"],
                ActivityEvent.event_type.in_(
                    [
                        "dashboard.share_added",
                        "dashboard.share_updated",
                        "dashboard.share_removed",
                    ]
                ),
            )
            .order_by(ActivityEvent.event_id)
        )
        share_events = result.scalars().all()

        assert [event.event_type for event in share_events] == [
            "dashboard.share_added",
            "dashboard.share_updated",
            "dashboard.share_removed",
        ]
        assert [event.payload["share_action"] for event in share_events] == [
            "added",
            "updated",
            "removed",
        ]
        assert all(event.payload["principal_id"] == shared_user_me["id"] for event in share_events)
        assert share_events[0].payload["role"] == "viewer"
        assert share_events[1].payload["role"] == "editor"
        assert share_events[2].payload["role"] == "editor"
    finally:
        await shared_user.__aexit__(None, None, None)


async def test_dashboard_mutations_emit_activity_events(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client, name="Realtime Board")

    set_csrf(auth_client)
    rename_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"name": "Realtime Board Renamed"},
    )
    assert rename_resp.status_code == 200

    set_csrf(auth_client)
    layout_resp = await auth_client.put(
        f"/api/dashboards/{dashboard['id']}/layout",
        json={"layout": [{"i": "sample", "x": 0, "y": 0, "w": 4, "h": 3}], "version": 0},
    )
    assert layout_resp.status_code == 200

    set_csrf(auth_client)
    add_widget_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/widgets",
        json={"widget_type": "clock", "config": {"title": "UTC Clock"}},
    )
    assert add_widget_resp.status_code == 201
    widget_id = add_widget_resp.json()["widgets"][0]["id"]

    set_csrf(auth_client)
    update_widget_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}/widgets/{widget_id}",
        json={"config": {"title": "Updated Clock"}},
    )
    assert update_widget_resp.status_code == 200

    set_csrf(auth_client)
    delete_widget_resp = await auth_client.delete(
        f"/api/dashboards/{dashboard['id']}/widgets/{widget_id}",
    )
    assert delete_widget_resp.status_code == 204

    set_csrf(auth_client)
    delete_dashboard_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert delete_dashboard_resp.status_code == 204

    result = await db_session.execute(select(ActivityEvent.event_type).order_by(ActivityEvent.event_id))
    event_types = [row[0] for row in result.all()]

    assert "dashboard.created" in event_types
    assert "dashboard.deleted" in event_types
    assert event_types.count("dashboard.updated") >= 4


async def test_dashboard_update_events_include_current_version_and_client_mutation_id(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    dashboard = await create_dashboard(auth_client, name="Contract Board")
    shared_user = await register_client("dashboard-contract-viewer@example.com", display_name="Viewer")

    try:
        shared_user_me = await current_user(shared_user)

        set_csrf(auth_client)
        layout_resp = await auth_client.put(
            f"/api/dashboards/{dashboard['id']}/layout",
            json={"layout": [{"i": "sample", "x": 0, "y": 0, "w": 4, "h": 3}], "version": 0},
        )
        assert layout_resp.status_code == 200

        set_csrf(auth_client)
        add_widget_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/widgets",
            json={"widget_type": "clock", "config": {"title": "UTC Clock"}},
        )
        assert add_widget_resp.status_code == 201
        widget_id = add_widget_resp.json()["widgets"][0]["id"]

        set_csrf(auth_client)
        rename_resp = await auth_client.patch(
            f"/api/dashboards/{dashboard['id']}",
            headers={"X-Client-Mutation-Id": "rename-123"},
            json={"name": "Contract Board Renamed"},
        )
        assert rename_resp.status_code == 200

        set_csrf(auth_client)
        update_widget_resp = await auth_client.patch(
            f"/api/dashboards/{dashboard['id']}/widgets/{widget_id}",
            headers={"X-Client-Mutation-Id": "widget-123"},
            json={"config": {"title": "Updated Clock"}},
        )
        assert update_widget_resp.status_code == 200

        set_csrf(auth_client)
        add_share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            headers={"X-Client-Mutation-Id": "share-123"},
            json={"principal_type": "user", "principal_id": shared_user_me["id"], "role": "viewer"},
        )
        assert add_share_resp.status_code == 201

        result = await db_session.execute(
            select(ActivityEvent)
            .where(
                ActivityEvent.entity_type == "dashboard",
                ActivityEvent.entity_id == dashboard["id"],
            )
            .order_by(ActivityEvent.event_id)
        )
        events = result.scalars().all()

        rename_event = next(event for event in events if event.payload.get("client_mutation_id") == "rename-123")
        widget_event = next(event for event in events if event.payload.get("client_mutation_id") == "widget-123")
        share_event = next(event for event in events if event.payload.get("client_mutation_id") == "share-123")

        assert rename_event.entity_version == 2
        assert rename_event.payload["changed_fields"] == ["name"]
        assert widget_event.entity_version == 2
        assert widget_event.payload["changed_fields"] == ["widgets"]
        assert share_event.event_type == "dashboard.share_added"
        assert share_event.entity_version == 2
        assert share_event.payload["changed_fields"] == ["shares"]
    finally:
        await shared_user.__aexit__(None, None, None)


async def test_empty_dashboard_patch_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    set_csrf(auth_client)
    resp = await auth_client.patch(f"/api/dashboards/{dashboard['id']}", json={})
    assert resp.status_code == 422
