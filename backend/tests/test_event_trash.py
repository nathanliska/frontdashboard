"""The calendar trash: what it lists, who may reach it, and what purging takes with it."""

import uuid

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.calendar import CalendarEvent, CalendarEventOverride, CalendarEventParticipant
from app.routers import calendar as calendar_router
from tests.helpers import (
    create_calendar_event,
    create_dashboard,
    current_user,
    register_client,
    set_csrf,
    share_dashboard,
)


async def test_the_listing_route_is_not_shadowed_by_the_event_id_route(auth_client: AsyncClient) -> None:
    """`/events/trash` must be declared above `/events/{event_id}`.

    Below it, FastAPI matches "trash" as an event id and answers 422 from UUID parsing — a failure
    that looks like a bad request rather than a routing mistake. Ordering is the only thing that
    prevents it, and nothing else would notice a reorder.
    """
    resp = await auth_client.get("/api/calendar/events/trash")
    assert resp.status_code == 200, resp.text
    assert isinstance(resp.json()["items"], list)


async def test_a_deleted_event_appears_in_the_trash_with_its_purge_date(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Bin day")

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    resp = await auth_client.get("/api/calendar/events/trash")
    assert resp.status_code == 200
    (entry,) = [e for e in resp.json()["items"] if e["id"] == event["id"]]
    assert entry["title"] == "Bin day"
    assert entry["dashboard_id"] == dashboard["id"]
    assert entry["purge_at"] > entry["deleted_at"], "the deadline must be after the deletion"


async def test_a_live_event_is_not_in_the_trash(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    resp = await auth_client.get("/api/calendar/events/trash")
    assert [e for e in resp.json()["items"] if e["id"] == event["id"]] == []


async def test_the_trash_is_scoped_to_dashboards_the_caller_can_see(auth_client: AsyncClient) -> None:
    """Access, not authorship — but a stranger's dashboard must not leak in either."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Private")
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    stranger = await register_client("event-trash-stranger@example.com")
    try:
        resp = await stranger.get("/api/calendar/events/trash")
        assert resp.status_code == 200
        assert [e for e in resp.json()["items"] if e["id"] == event["id"]] == []
    finally:
        await stranger.__aexit__(None, None, None)


async def test_events_under_a_trashed_dashboard_are_excluded(auth_client: AsyncClient) -> None:
    """They return with the dashboard, so listing them separately would offer a restore that lies.

    True only because the listing goes through `list_accessible_dashboard_ids`, which filters
    trashed dashboards — a refactor there would break this silently.
    """
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Goes with it")
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204
    assert [e["id"] for e in (await auth_client.get("/api/calendar/events/trash")).json()["items"]] == [event["id"]]

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204

    listed = (await auth_client.get("/api/calendar/events/trash")).json()["items"]
    assert [e for e in listed if e["id"] == event["id"]] == []


async def test_an_editor_sees_and_can_purge_what_the_owner_trashed(auth_client: AsyncClient) -> None:
    """Whoever can edit the dashboard put it there and can take it back."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Shared")

    editor = await register_client("event-trash-editor@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], editor, "editor")

        set_csrf(auth_client)
        assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

        listed = await editor.get("/api/calendar/events/trash")
        assert [e["id"] for e in listed.json()["items"]] == [event["id"]]

        set_csrf(editor)
        assert (await editor.delete(f"/api/calendar/events/{event['id']}/trash")).status_code == 204
    finally:
        await editor.__aexit__(None, None, None)


async def test_a_viewer_cannot_purge(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    viewer = await register_client("event-trash-viewer@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], viewer, "viewer")

        set_csrf(auth_client)
        assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

        set_csrf(viewer)
        assert (await viewer.delete(f"/api/calendar/events/{event['id']}/trash")).status_code == 403
    finally:
        await viewer.__aexit__(None, None, None)


async def test_purge_refuses_an_event_that_is_not_trashed(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}/trash")).status_code == 404


async def test_purging_takes_the_children_with_it(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Overrides, participants and reminders cascade — so one delete must leave nothing behind."""
    dashboard = await create_dashboard(auth_client)
    me = await current_user(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Weekly",
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [4]},
        participants=[me["id"]],
    )

    set_csrf(auth_client)
    override = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={"occurrence_start": event["starts_at"], "cancelled": True},
    )
    assert override.status_code == 200, override.text

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}/trash")).status_code == 204

    for model in (CalendarEvent, CalendarEventOverride, CalendarEventParticipant):
        remaining = await db_session.scalar(select(func.count()).select_from(model))
        assert remaining == 0, model.__name__


async def test_purging_removes_it_from_the_trash_and_from_restore(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{event['id']}/trash")).status_code == 204

    listed = await auth_client.get("/api/calendar/events/trash")
    assert [e for e in listed.json()["items"] if e["id"] == event["id"]] == []

    set_csrf(auth_client)
    assert (await auth_client.post(f"/api/calendar/events/{event['id']}/restore")).status_code == 404


async def _trash_page(client: AsyncClient, cursor: dict | None = None) -> dict:
    """One page of the trash — `items` plus `next_cursor` — continuing from `cursor` when given."""
    params = {} if cursor is None else {"before": cursor["deleted_at"], "before_id": cursor["id"]}
    resp = await client.get("/api/calendar/events/trash", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_the_cursor_walks_past_the_first_page(auth_client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(calendar_router, "_TRASH_PAGE_SIZE", 2)
    dashboard = await create_dashboard(auth_client)
    events = [await create_calendar_event(auth_client, dashboard["id"], title=f"E{n}") for n in range(5)]

    set_csrf(auth_client)
    for event in events:
        assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    seen: list[str] = []
    page = await _trash_page(auth_client)
    # Bounded: a cursor that fails to advance repeats the same page forever, and a hang reads as a
    # stuck CI run rather than as this assertion.
    for _ in range(len(events) + 1):
        seen.extend(e["id"] for e in page["items"])
        if page["next_cursor"] is None:
            break
        page = await _trash_page(auth_client, page["next_cursor"])

    # Newest deletion first, and every event reachable — the point of paging over truncating.
    assert seen == [e["id"] for e in reversed(events)]
    assert page["next_cursor"] is None, "the walk must end by being told so, not by running out of rows"


async def test_restoring_from_a_page_does_not_hide_the_next_one(auth_client: AsyncClient, monkeypatch) -> None:
    """The reason this pages by cursor rather than offset.

    The caller restores and purges from this very list, so rows leave it between requests. Under
    `OFFSET 3` the row that slid across the boundary is never shown again — silently unrecoverable,
    which is the one thing a recovery list may not do.
    """
    monkeypatch.setattr(calendar_router, "_TRASH_PAGE_SIZE", 3)
    dashboard = await create_dashboard(auth_client)
    events = [await create_calendar_event(auth_client, dashboard["id"], title=f"E{n}") for n in range(6)]

    set_csrf(auth_client)
    for event in events:
        assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    first = await _trash_page(auth_client)
    assert len(first["items"]) == 3

    set_csrf(auth_client)
    restored = first["items"][0]["id"]
    assert (await auth_client.post(f"/api/calendar/events/{restored}/restore")).status_code == 200

    rest = await _trash_page(auth_client, first["next_cursor"])

    still_trashed = {e["id"] for e in events} - {restored}
    assert {e["id"] for e in first["items"]} - {restored} | {e["id"] for e in rest["items"]} == still_trashed


async def test_a_page_that_exactly_fills_is_the_last_one(auth_client: AsyncClient, monkeypatch) -> None:
    """Exactly a page of rows means the end, not another page.

    Deciding by page length instead cannot tell "full" from "more to come", so it offers a next page
    that comes back empty. Fetching one row past the page is what distinguishes them.
    """
    monkeypatch.setattr(calendar_router, "_TRASH_PAGE_SIZE", 3)
    dashboard = await create_dashboard(auth_client)
    events = [await create_calendar_event(auth_client, dashboard["id"], title=f"E{n}") for n in range(3)]

    set_csrf(auth_client)
    for event in events:
        assert (await auth_client.delete(f"/api/calendar/events/{event['id']}")).status_code == 204

    page = await _trash_page(auth_client)
    assert len(page["items"]) == 3
    assert page["next_cursor"] is None

    # And one more row flips it, so the None above is a real decision rather than a stuck default.
    extra = await create_calendar_event(auth_client, dashboard["id"], title="E3")
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/calendar/events/{extra['id']}")).status_code == 204
    assert (await _trash_page(auth_client))["next_cursor"] is not None


async def test_a_half_given_cursor_is_rejected(auth_client: AsyncClient) -> None:
    """Both halves or neither: `before` alone would order by a non-unique key and skip ties."""
    resp = await auth_client.get("/api/calendar/events/trash", params={"before": "2026-01-01T00:00:00+00:00"})
    assert resp.status_code == 422


async def test_a_naive_cursor_is_rejected(auth_client: AsyncClient) -> None:
    """Accepting it would page from the wrong instant for any client sending local time.

    Silently, and in the direction that skips rows — so it is refused rather than coerced, matching
    how the occurrence window params in this router treat a naive bound.
    """
    resp = await auth_client.get(
        "/api/calendar/events/trash",
        params={"before": "2026-01-01T00:00:00", "before_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 422
    assert "timezone-aware" in resp.text
