import uuid

from httpx import AsyncClient

from tests.helpers import create_calendar_event, create_dashboard, register_client, set_csrf


async def test_create_private_calendar_event(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    assert event["title"] == "Dentist"
    assert event["recurrence"] is None


async def test_shared_dashboard_event_visible_to_shared_user(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(auth_client, dashboard["id"], title="Family Dinner")

    viewer = await register_client("calendar-viewer@example.com")
    try:
        me = await viewer.get("/api/auth/me")
        set_csrf(auth_client)
        await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "viewer"},
        )

        resp = await viewer.get(
            "/api/calendar/events",
            params={
                "window_start": "2026-04-10T00:00:00+00:00",
                "window_end": "2026-04-11T00:00:00+00:00",
                "dashboard_id": dashboard["id"],
            },
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        await viewer.__aexit__(None, None, None)


async def test_list_private_occurrences_for_recurring_event(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Workout",
        recurrence={"frequency": "daily", "interval": 1, "count": 3},
    )

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-14T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    starts = [item["occurrence_start"] for item in resp.json()]
    assert starts == [
        "2026-04-10T14:00:00Z",
        "2026-04-11T14:00:00Z",
        "2026-04-12T14:00:00Z",
    ]


async def test_occurrence_override_updates_one_instance(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Standup",
        recurrence={"frequency": "daily", "interval": 1, "count": 3},
    )

    set_csrf(auth_client)
    patch_resp = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={
            "occurrence_start": "2026-04-11T14:00:00+00:00",
            "title": "Moved Standup",
            "starts_at": "2026-04-11T16:00:00+00:00",
            "ends_at": "2026-04-11T17:00:00+00:00",
        },
    )
    assert patch_resp.status_code == 200, patch_resp.text
    payload = patch_resp.json()
    assert payload["cancelled"] is False
    assert payload["occurrence"]["title"] == "Moved Standup"


async def test_viewer_cannot_edit_event(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    client = await register_client("calendar-viewer-edit@example.com")
    try:
        me = await client.get("/api/auth/me")
        assert me.status_code == 200
        set_csrf(auth_client)
        await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "viewer"},
        )

        set_csrf(client)
        update_resp = await client.patch(
            f"/api/calendar/events/{event['id']}",
            json={"title": "Hijacked"},
        )
        assert update_resp.status_code == 403
    finally:
        await client.__aexit__(None, None, None)


async def test_event_detail_update_and_delete(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Planning Session")

    detail_resp = await auth_client.get(f"/api/calendar/events/{event['id']}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["title"] == "Planning Session"

    set_csrf(auth_client)
    update_resp = await auth_client.patch(
        f"/api/calendar/events/{event['id']}",
        json={"title": "Updated Planning Session"},
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["title"] == "Updated Planning Session"

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/calendar/events/{event['id']}")
    assert delete_resp.status_code == 204

    get_resp = await auth_client.get(f"/api/calendar/events/{event['id']}")
    assert get_resp.status_code == 404


async def test_event_shares_are_dashboard_managed(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    share_id = uuid.uuid4()

    list_resp = await auth_client.get(f"/api/calendar/events/{event['id']}/shares")
    assert list_resp.status_code == 200
    payload = list_resp.json()
    assert payload["direct_shares"] == []
    assert payload["inherited_dashboards"][0]["dashboard_id"] == dashboard["id"]

    set_csrf(auth_client)
    create_resp = await auth_client.post(f"/api/calendar/events/{event['id']}/shares")
    assert create_resp.status_code == 409
    assert create_resp.json()["detail"] == "Event permissions are managed on the parent dashboard"

    set_csrf(auth_client)
    update_resp = await auth_client.patch(f"/api/calendar/events/{event['id']}/shares/{share_id}")
    assert update_resp.status_code == 409
    assert update_resp.json()["detail"] == "Event permissions are managed on the parent dashboard"

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/calendar/events/{event['id']}/shares/{share_id}")
    assert delete_resp.status_code == 409
    assert delete_resp.json()["detail"] == "Event permissions are managed on the parent dashboard"


async def test_empty_event_patch_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    set_csrf(auth_client)
    resp = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={})
    assert resp.status_code == 422
