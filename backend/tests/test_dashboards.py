import uuid
from datetime import UTC, datetime, timedelta

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


async def test_home_dashboard_listing_and_shared_access(auth_client: AsyncClient) -> None:
    me = await auth_client.get("/api/auth/me")
    assert me.status_code == 200
    home_dashboard_id = me.json()["preferences"]["home_dashboard_id"]

    # Registration seeds a home dashboard and names it in preferences; the client fetches it by id
    # like any other, so there is no dedicated "default dashboard" endpoint.
    home_resp = await auth_client.get(f"/api/dashboards/{home_dashboard_id}")
    assert home_resp.status_code == 200
    home_dashboard = home_resp.json()
    assert home_dashboard["id"] == home_dashboard_id
    assert home_dashboard["widgets"] == []
    assert home_dashboard["layout"] == []

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


async def test_widget_config_updates_are_validated_against_the_widget_type(auth_client: AsyncClient) -> None:
    """A bad widget config must die at the write.

    The body cannot discriminate itself, so the route validates against the stored widget's type;
    otherwise `{"timezone": 123}` is stored as-is and 500s every later read.
    """
    dashboard = await create_dashboard(auth_client, name="Config Guard")

    set_csrf(auth_client)
    add_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/widgets",
        json={"widget_type": "clock", "config": {"timezone": "UTC"}},
    )
    assert add_resp.status_code == 201
    widget_id = add_resp.json()["widgets"][0]["id"]

    set_csrf(auth_client)
    poison_resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}/widgets/{widget_id}",
        json={"config": {"timezone": 123}},
    )
    assert poison_resp.status_code == 422

    # The write was rejected, so the read path still works and serves the original config.
    detail_resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["widgets"][0]["config"]["timezone"] == "UTC"


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


async def test_client_id_header_is_bounded(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    set_csrf(auth_client)
    resp = await auth_client.patch(
        f"/api/dashboards/{dashboard['id']}",
        json={"name": "Renamed"},
        headers={"X-Client-Id": "x" * 129},
    )

    assert resp.status_code == 422


async def test_delete_moves_to_trash_and_restore_brings_everything_back(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """DELETE is a trash move: children and shares survive, and restore reverses it."""
    viewer = await register_client("trash-viewer@example.com", display_name="Viewer")
    try:
        viewer_me = await current_user(viewer)
        dashboard = await create_dashboard(auth_client, name="Trashable")
        lst = await create_list(auth_client, dashboard["id"], name="Kept List")
        await create_list_item(auth_client, lst["id"], text="kept")
        set_csrf(auth_client)
        share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": viewer_me["id"], "role": "viewer"},
        )
        assert share_resp.status_code == 201

        set_csrf(auth_client)
        assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204

        # Invisible to everyone through every normal door — owner and shared viewer alike.
        assert (await auth_client.get(f"/api/dashboards/{dashboard['id']}")).status_code == 404
        assert (await viewer.get(f"/api/dashboards/{dashboard['id']}")).status_code == 404
        assert dashboard["id"] not in [d["id"] for d in (await auth_client.get("/api/dashboards")).json()]
        assert (await auth_client.get(f"/api/lists/{lst['id']}")).status_code == 404

        # But present in the owner's trash, with a purge deadline — and only the owner's.
        trash = (await auth_client.get("/api/dashboards/trash")).json()
        assert [t["id"] for t in trash] == [dashboard["id"]]
        assert trash[0]["purge_at"] > trash[0]["deleted_at"]
        assert (await viewer.get("/api/dashboards/trash")).json() == []

        # The viewer cannot restore it; the owner can.
        set_csrf(viewer)
        assert (await viewer.post(f"/api/dashboards/{dashboard['id']}/restore")).status_code == 404
        set_csrf(auth_client)
        restored = await auth_client.post(f"/api/dashboards/{dashboard['id']}/restore")
        assert restored.status_code == 200
        assert restored.json()["name"] == "Trashable"

        # Back for both parties, share intact, children intact.
        assert (await viewer.get(f"/api/dashboards/{dashboard['id']}")).status_code == 200
        detail = (await auth_client.get(f"/api/lists/{lst['id']}")).json()
        assert [i["text"] for i in detail["items"]] == ["kept"]
        assert (await auth_client.get("/api/dashboards/trash")).json() == []
    finally:
        await viewer.aclose()


async def test_reaper_purges_expired_trash_and_lingering_soft_deletes(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Past the retention window the purge runs the full cascade.

    Children soft-deleted individually go too. The FKs have no ON DELETE cascade, so a missed
    child makes the dashboard delete itself raise.
    """
    from app.services.retention import reap_expired_trash

    dashboard = await create_dashboard(auth_client, name="Doomed")
    lst = await create_list(auth_client, dashboard["id"], name="Old List")
    item = await create_list_item(auth_client, lst["id"], text="stale")
    event = await create_calendar_event(auth_client, dashboard["id"], title="Old Event")

    # Soft-delete the list and event directly; the item stays under the soft-deleted list —
    # the exact orphan hazard the purge must sweep.
    now = datetime.now(UTC)
    db_list = (await db_session.execute(select(List).where(List.id == uuid.UUID(lst["id"])))).scalar_one()
    db_list.deleted_at = now
    db_event = (await db_session.execute(select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"])))).scalar_one()
    db_event.deleted_at = now
    await db_session.flush()

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204

    # Inside the window nothing is purged.
    counts = await reap_expired_trash(db_session, now=now)
    assert counts["dashboards"] == 0
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == uuid.UUID(dashboard["id"])))).scalar_one_or_none() is not None

    # Past it, everything goes — parent, both children, and the item.
    counts = await reap_expired_trash(db_session, now=now + timedelta(days=31))
    assert counts["dashboards"] == 1
    for model, row_id in ((Dashboard, dashboard["id"]), (List, lst["id"]), (ListItem, item["id"]), (CalendarEvent, event["id"])):
        assert (await db_session.execute(select(model).where(model.id == uuid.UUID(row_id)))).scalar_one_or_none() is None


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


async def test_deleting_a_list_strips_its_widget_from_every_layout(auth_client: AsyncClient) -> None:
    """Deleting the resource has to take the widget bound to it (`remove_resource_widgets`).

    A widget left behind pointing at a deleted list renders as a permanent error tile, and a
    layout entry left behind reserves grid space for a widget that no longer exists. Only the
    "nothing bound" early return of this service was exercised before — the part that actually
    edits the layout and bumps `version` had no test at all, on a path every list deletion runs.
    """
    dashboard = await create_dashboard(auth_client, name="Chores")

    set_csrf(auth_client)
    list_widget = (
        await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/widgets",
            json={"widget_type": "list", "config": {"name": "Errands", "list_type": "todo"}},
        )
    ).json()["widgets"][0]

    set_csrf(auth_client)
    after_clock = (
        await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/widgets",
            json={"widget_type": "clock", "config": {"timezone": "UTC"}},
        )
    ).json()
    clock_widget_id = next(w["id"] for w in after_clock["widgets"] if w["widget_type"] == "clock")
    version_before = after_clock["version"]
    assert {item["i"] for item in after_clock["layout"]} == {list_widget["id"], clock_widget_id}

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/lists/{list_widget['resource_id']}")
    assert delete_resp.status_code == 204, delete_resp.text

    detail = (await auth_client.get(f"/api/dashboards/{dashboard['id']}")).json()
    assert [w["id"] for w in detail["widgets"]] == [clock_widget_id], "the bound widget outlived its list"
    assert [item["i"] for item in detail["layout"]] == [clock_widget_id], "its layout slot was left reserved"
    # The bump is what tells another open tab its copy of the layout is stale; without it a
    # concurrent save would overwrite this edit and silently restore the dead widget's slot.
    assert detail["version"] > version_before


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
    # A PATCH replacing the whole config round-trips the typed keys as null, while `title`
    # survives via `extra="allow"`.
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
    """A list created through add-widget must append after the existing ones.

    Inheriting sort_order=0 would tie it for first place.
    """
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


async def test_trashing_a_shared_dashboard_notifies_the_people_who_lose_access(
    auth_client: AsyncClient,
) -> None:
    """Trashing hides the dashboard from everyone it was shared with.

    The SSE frame reaches only whoever is connected at that instant; the stored notification is
    what everyone else sees on their next visit.
    """
    dashboard = await create_dashboard(auth_client, name="Doomed Board")

    shared_user = await register_client("dashboard-trash-notify@example.com", display_name="Shared User")
    try:
        shared_user_me = await current_user(shared_user)
        set_csrf(auth_client)
        add_share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": shared_user_me["id"], "role": "editor"},
        )
        assert add_share_resp.status_code == 201

        set_csrf(auth_client)
        delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
        assert delete_resp.status_code == 204

        # The access loss the notification is explaining.
        assert (await shared_user.get(f"/api/dashboards/{dashboard['id']}")).status_code == 404

        shared_items = (await shared_user.get("/api/notifications")).json()["items"]
        trashed = [n for n in shared_items if n["type"] == "dashboard.deleted"]
        assert len(trashed) == 1
        assert trashed[0]["reference_id"] == dashboard["id"]
        assert "Doomed Board" in trashed[0]["body"]

        # The actor already knows; notifying the deleter would be noise.
        owner_items = (await auth_client.get("/api/notifications")).json()["items"]
        assert [n for n in owner_items if n["type"] == "dashboard.deleted"] == []
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


async def test_dashboard_update_events_include_current_version_and_origin_client_id(
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
            headers={"X-Client-Id": "rename-123"},
            json={"name": "Contract Board Renamed"},
        )
        assert rename_resp.status_code == 200

        set_csrf(auth_client)
        update_widget_resp = await auth_client.patch(
            f"/api/dashboards/{dashboard['id']}/widgets/{widget_id}",
            headers={"X-Client-Id": "widget-123"},
            json={"config": {"title": "Updated Clock"}},
        )
        assert update_widget_resp.status_code == 200

        set_csrf(auth_client)
        add_share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            headers={"X-Client-Id": "share-123"},
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

        rename_event = next(event for event in events if event.payload.get("origin_client_id") == "rename-123")
        widget_event = next(event for event in events if event.payload.get("origin_client_id") == "widget-123")
        share_event = next(event for event in events if event.payload.get("origin_client_id") == "share-123")

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


async def test_binding_the_same_list_twice_is_a_conflict(auth_client: AsyncClient) -> None:
    """One list maps to at most one widget per dashboard; the second add is a 409, not a 500.

    This exercises the friendly pre-check. The race window behind it (two adds interleaving past
    the check) lands on uq_dashboard_widgets_resource_binding and is translated to the same 409
    by add_widget's IntegrityError handler; the constraint itself is pinned in
    test_schema_invariants.py (finding #26).
    """
    dashboard = await create_dashboard(auth_client, name="Bind Twice")
    lst = await create_list(auth_client, dashboard["id"], name="Bound")

    payload = {"widget_type": "list", "resource_type": "list", "resource_id": lst["id"]}
    set_csrf(auth_client)
    first = await auth_client.post(f"/api/dashboards/{dashboard['id']}/widgets", json=payload)
    assert first.status_code == 201

    set_csrf(auth_client)
    second = await auth_client.post(f"/api/dashboards/{dashboard['id']}/widgets", json=payload)
    assert second.status_code == 409
    assert "already on this dashboard" in second.json()["detail"]
