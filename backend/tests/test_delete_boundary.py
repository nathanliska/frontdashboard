"""The delete boundary: items go outright, events are recoverable (ADR-007)."""

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.calendar import CalendarEvent
from app.models.list import ListItem
from tests.helpers import (
    create_calendar_event,
    create_dashboard,
    create_list,
    create_list_item,
    current_user,
    register_client,
    set_csrf,
    share_dashboard,
)


async def test_deleting_an_item_removes_the_row(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """No tombstone, so nothing survives to occupy quota or be resurrected by a dropped filter."""
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"])

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/lists/{lst['id']}/items/{item['id']}")).status_code == 204

    remaining = await db_session.scalar(select(func.count()).select_from(ListItem))
    assert remaining == 0


async def test_deleting_an_item_frees_quota_at_once(auth_client: AsyncClient, monkeypatch) -> None:
    """The whole point of dropping the tombstone: the cap stops counting rows the user cannot see."""
    monkeypatch.setattr(settings, "quota_items_per_user", 1)
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"], text="one")

    set_csrf(auth_client)
    blocked = await auth_client.post(f"/api/lists/{lst['id']}/items", json={"text": "two"})
    assert blocked.status_code == 422

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/lists/{lst['id']}/items/{item['id']}")).status_code == 204

    set_csrf(auth_client)
    allowed = await auth_client.post(f"/api/lists/{lst['id']}/items", json={"text": "two"})
    assert allowed.status_code == 201


async def test_restoring_an_event_brings_back_what_made_it_expensive(auth_client: AsyncClient) -> None:
    """Recurrence and participants are why an event is worth tombstoning; assert they survive."""
    dashboard = await create_dashboard(auth_client)
    me = await current_user(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Trash pickup",
        description="Bins to the curb",
        recurrence={"frequency": "weekly", "interval": 2, "by_weekday": [1]},
        participants=[me["id"]],
    )

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204
    assert (await auth_client.get(f"/api/calendar/events/{event['id']}")).status_code == 404

    set_csrf(auth_client)
    restored = await auth_client.post(f"/api/calendar/events/{event['id']}/restore")
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["title"] == "Trash pickup"
    assert body["description"] == "Bins to the curb"
    assert body["recurrence"]["frequency"] == "weekly"
    assert body["recurrence"]["interval"] == 2
    assert body["recurrence"]["by_weekday"] == [1]
    assert [p["user_id"] for p in body["participants"]] == [me["id"]]

    assert (await auth_client.get(f"/api/calendar/events/{event['id']}")).status_code == 200


async def test_restore_refuses_an_event_that_is_not_deleted(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    set_csrf(auth_client)
    assert (await auth_client.post(f"/api/calendar/events/{event['id']}/restore")).status_code == 404


async def test_restore_is_refused_to_a_viewer(auth_client: AsyncClient) -> None:
    """Restore is a write, so it takes edit — a viewer must not undo someone else's delete."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    viewer = await register_client("restore-viewer@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], viewer, "viewer")

        set_csrf(auth_client)
        assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

        set_csrf(viewer)
        assert (await viewer.post(f"/api/calendar/events/{event['id']}/restore")).status_code == 403
    finally:
        await viewer.__aexit__(None, None, None)


async def test_restore_is_refused_to_a_stranger(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    stranger = await register_client("restore-stranger@example.com")
    try:
        set_csrf(stranger)
        assert (await stranger.post(f"/api/calendar/events/{event['id']}/restore")).status_code == 404
    finally:
        await stranger.__aexit__(None, None, None)


async def test_a_deleted_event_still_counts_until_the_reaper(auth_client: AsyncClient, db_session: AsyncSession, monkeypatch) -> None:
    """Events keep their tombstone, so the quota keeps counting them — the refusal says so."""
    monkeypatch.setattr(settings, "quota_events_per_user", 1)
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    set_csrf(auth_client)
    blocked = await auth_client.post(
        "/api/calendar/events",
        json={
            "title": "Next",
            "starts_at": "2026-05-10T14:00:00+00:00",
            "ends_at": "2026-05-10T15:00:00+00:00",
            "timezone": "UTC",
            "all_day": False,
            "dashboard_id": dashboard["id"],
        },
    )
    assert blocked.status_code == 422
    assert "trash horizon" in blocked.json()["detail"]

    surviving = await db_session.scalar(select(func.count()).select_from(CalendarEvent))
    assert surviving == 1
