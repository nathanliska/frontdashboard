from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from tests.helpers import create_dashboard, current_user, register_client, set_csrf


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
        assert dashboards[shared_dashboard["id"]]["access_description"] == "Shared directly with you"
        assert dashboards[shared_dashboard["id"]]["is_shared"] is True
    finally:
        await owner.__aexit__(None, None, None)


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
    assert update_resp.json()["config"] == {"title": "Pinned Errands"}

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/widgets/{widget['id']}")
    assert delete_resp.status_code == 204

    detail_resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["widgets"] == []
    assert detail_resp.json()["layout"] == []


async def test_dashboard_calendar_routes_and_delete(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Calendar Dashboard")

    set_csrf(auth_client)
    create_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/calendar-events",
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
        f"/api/dashboards/{dashboard['id']}/calendar-occurrences",
        params={
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
