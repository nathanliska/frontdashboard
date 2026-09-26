import uuid
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from prometheus_client import REGISTRY
from sqlalchemy import event as sa_event
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.calendar import CalendarEvent, CalendarEventOverride
from app.routers import calendar as calendar_router
from app.services.sessions import start_session
from tests.helpers import (
    MemberFactory,
    create_calendar_event,
    create_dashboard,
    make_db_dashboard,
    make_db_user,
    share_dashboard,
)


async def test_create_private_calendar_event(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    assert event["title"] == "Dentist"
    assert event["recurrence"] is None


async def test_shared_dashboard_event_visible_to_shared_user(auth_client: AsyncClient, accounts: MemberFactory) -> None:
    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(auth_client, dashboard["id"], title="Family Dinner")

    viewer = await accounts("calendar-viewer@example.com")
    await share_dashboard(auth_client, dashboard["id"], viewer, "viewer")

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


async def test_edited_occurrences_on_one_series_are_capped(auth_client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "quota_overrides_per_event", 1)
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Standup",
        recurrence={"frequency": "daily", "interval": 1, "count": 3},
    )

    async def edit(day: int, title: str):
        return await auth_client.patch(
            f"/api/calendar/events/{event['id']}/occurrences",
            json={"occurrence_start": f"2026-04-{day:02d}T14:00:00+00:00", "title": title},
        )

    assert (await edit(11, "Moved")).status_code == 200
    refused = await edit(12, "Another")
    assert refused.status_code == 422
    assert "edited occurrences" in refused.json()["detail"]
    assert (await edit(11, "Moved again")).status_code == 200


async def test_viewer_cannot_edit_event(auth_client: AsyncClient, accounts: MemberFactory) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    client = await accounts("calendar-viewer-edit@example.com")
    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    await share_dashboard(auth_client, dashboard["id"], client, "viewer")

    update_resp = await client.patch(
        f"/api/calendar/events/{event['id']}",
        json={"title": "Hijacked"},
    )
    assert update_resp.status_code == 403


async def test_event_detail_update_and_delete(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Planning Session")

    detail_resp = await auth_client.get(f"/api/calendar/events/{event['id']}")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["title"] == "Planning Session"

    update_resp = await auth_client.patch(
        f"/api/calendar/events/{event['id']}",
        json={"title": "Updated Planning Session"},
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["title"] == "Updated Planning Session"

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

    create_resp = await auth_client.post(f"/api/calendar/events/{event['id']}/shares")
    assert create_resp.status_code == 409
    assert create_resp.json()["detail"] == "Event permissions are managed on the parent dashboard"

    update_resp = await auth_client.patch(f"/api/calendar/events/{event['id']}/shares/{share_id}")
    assert update_resp.status_code == 409
    assert update_resp.json()["detail"] == "Event permissions are managed on the parent dashboard"

    delete_resp = await auth_client.delete(f"/api/calendar/events/{event['id']}/shares/{share_id}")
    assert delete_resp.status_code == 409
    assert delete_resp.json()["detail"] == "Event permissions are managed on the parent dashboard"


async def test_empty_event_patch_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])

    resp = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={})
    assert resp.status_code == 422


async def test_out_of_window_one_off_events_are_not_loaded(auth_client: AsyncClient) -> None:
    """Non-recurring events are bounded in SQL by their own times.

    Behaviour is unchanged — they were already discarded after expansion — so this pins the
    filter against dropping something it should have kept.
    """
    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(auth_client, dashboard["id"], title="In window")
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Long past",
        starts_at="2019-01-02T14:00:00+00:00",
        ends_at="2019-01-02T15:00:00+00:00",
    )
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Far future",
        starts_at="2031-01-02T14:00:00+00:00",
        ends_at="2031-01-02T15:00:00+00:00",
    )
    # Straddles the window boundary: starts before it, ends inside it.
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Straddling",
        starts_at="2026-04-09T23:00:00+00:00",
        ends_at="2026-04-10T01:00:00+00:00",
    )

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    assert sorted(item["title"] for item in resp.json()) == ["In window", "Straddling"]


async def test_recurring_series_starting_before_the_window_still_expands(auth_client: AsyncClient) -> None:
    """The window filter must never bound a recurring event by its own start."""
    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Standup",
        starts_at="2019-01-02T14:00:00+00:00",
        ends_at="2019-01-02T14:15:00+00:00",
        recurrence={"frequency": "daily", "interval": 1},
    )

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-12T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    starts = [item["occurrence_start"] for item in resp.json()]
    assert starts == ["2026-04-10T14:00:00Z", "2026-04-11T14:00:00Z"]


async def test_finished_and_unstarted_series_are_not_loaded(
    auth_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recurring events are bounded by the two facts already in the row.

    A series cannot produce an occurrence before its own `starts_at`, and one carrying `until`
    cannot produce one after it. Both are read from the row and the JSONB rule, so unlike a
    persisted last-occurrence column there is nothing that can drift out of date.

    Counted at the expander rather than asserted on the response, because the response cannot
    see this: the expander already discarded these series in Python, so the JSON was identical
    before the SQL predicate existed. What changed is how much work produced it, and the only
    way to observe that is to count what reached the expander.
    """
    expanded: list[str] = []
    real_expand = calendar_router.expand_event_occurrences

    def counting_expand(event, *args, **kwargs):
        expanded.append(event.title)
        return real_expand(event, *args, **kwargs)

    monkeypatch.setattr(calendar_router, "expand_event_occurrences", counting_expand)

    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Live series",
        starts_at="2026-01-05T14:00:00+00:00",
        ends_at="2026-01-05T14:30:00+00:00",
        recurrence={"frequency": "daily", "interval": 1},
    )
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Finished series",
        starts_at="2019-01-02T14:00:00+00:00",
        ends_at="2019-01-02T14:30:00+00:00",
        recurrence={"frequency": "daily", "interval": 1, "until": "2019-06-01T14:00:00+00:00"},
    )
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Unstarted series",
        starts_at="2031-01-02T14:00:00+00:00",
        ends_at="2031-01-02T14:30:00+00:00",
        recurrence={"frequency": "daily", "interval": 1},
    )

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    assert [item["title"] for item in resp.json()] == ["Live series"]
    # The two dead series never reach Python at all.
    assert expanded == ["Live series"]


async def test_creating_an_all_day_event_snaps_it_to_whole_local_days(auth_client: AsyncClient) -> None:
    """`all_day` was a passthrough flag, so the client's arbitrary times were stored verbatim."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Conference",
        starts_at="2026-07-25T13:00:00-04:00",  # 09:00 local — the shape production accumulated
        ends_at="2026-07-25T21:30:00-04:00",
        timezone="America/New_York",
        all_day=True,
    )

    # Midnight New York on the 25th is 04:00Z; the exclusive end is midnight on the 26th.
    assert event["starts_at"] == "2026-07-25T04:00:00Z"
    assert event["ends_at"] == "2026-07-26T04:00:00Z"


async def test_flipping_an_existing_event_to_all_day_snaps_it_too(auth_client: AsyncClient) -> None:
    """The edit path matters as much as create — and a repeated edit must not grow the event."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        starts_at="2026-07-25T13:00:00-04:00",
        ends_at="2026-07-25T14:00:00-04:00",
        timezone="America/New_York",
        all_day=False,
    )

    flipped = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"all_day": True})
    assert flipped.status_code == 200, flipped.text
    assert flipped.json()["starts_at"] == "2026-07-25T04:00:00Z"
    assert flipped.json()["ends_at"] == "2026-07-26T04:00:00Z"

    # Idempotence through the API: touching an unrelated field re-runs the snap, and the event
    # must not gain a day each time it is edited.
    again = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"title": "Renamed"})
    assert again.status_code == 200, again.text
    assert again.json()["starts_at"] == "2026-07-25T04:00:00Z"
    assert again.json()["ends_at"] == "2026-07-26T04:00:00Z"


async def test_a_past_one_off_event_is_not_loaded_as_an_unbounded_series(
    auth_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-recurring event must be bounded by its own times, not treated as a series.

    This is the JSONB-null bug. `recurrence` was a plain `JSONB` column, and SQLAlchemy's JSON
    types default to `none_as_null=False`, so a Python `None` was stored as the JSONB scalar
    `null` — which is *not* SQL NULL and therefore satisfies `IS NOT NULL`. Every one-off event
    was consequently matched by the recurring branch, and since `recurrence['until']` is NULL for
    a JSONB null it took the "unbounded series" path, whose only bound is `starts_at < window_end`.
    Past one-off events loaded on every request; production had 33 of them.

    Counted at the expander, not asserted on the response, for the usual reason: Python reads a
    JSONB null back as `None`, so the expander emitted a single occurrence and `_overlaps` dropped
    it. The JSON was byte-identical whether or not the row should ever have been fetched.
    """
    expanded: list[str] = []
    real_expand = calendar_router.expand_event_occurrences

    def counting_expand(event, *args, **kwargs):
        expanded.append(event.title)
        return real_expand(event, *args, **kwargs)

    monkeypatch.setattr(calendar_router, "expand_event_occurrences", counting_expand)

    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Last year's lunch",
        starts_at="2025-03-04T12:00:00+00:00",
        ends_at="2025-03-04T13:00:00+00:00",
    )

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    assert resp.json() == []
    assert expanded == []


async def test_a_series_ending_at_the_window_edge_is_kept(auth_client: AsyncClient) -> None:
    """`until` bounds the last *start*; the occurrence it names still has a duration.

    A naive `until > window_start` would drop this series, because its final occurrence starts
    the evening before the window and runs into it — the same straddling case the one-off filter
    handles by comparing against `ends_at`.
    """
    dashboard = await create_dashboard(auth_client)
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Overnight shift",
        starts_at="2026-01-05T22:00:00+00:00",
        ends_at="2026-01-06T06:00:00+00:00",
        recurrence={"frequency": "daily", "interval": 1, "until": "2026-04-09T22:00:00+00:00"},
    )

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    assert [item["title"] for item in resp.json()] == ["Overnight shift"]


async def test_an_override_rescues_a_series_the_window_bounds_would_drop(auth_client: AsyncClient) -> None:
    """The unbounded override EXISTS is what makes the two bounds above safe.

    An override can retime an occurrence anywhere — including out of a finished series and into
    a window months later. Bound the override clause too and this event disappears.
    """
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Moved from a finished series",
        starts_at="2019-01-02T14:00:00+00:00",
        ends_at="2019-01-02T15:00:00+00:00",
        recurrence={"frequency": "daily", "interval": 1, "until": "2019-01-05T14:00:00+00:00"},
    )
    moved = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={
            "occurrence_start": "2019-01-03T14:00:00+00:00",
            "starts_at": "2026-04-10T09:00:00+00:00",
            "ends_at": "2026-04-10T10:00:00+00:00",
        },
    )
    assert moved.status_code == 200, moved.text

    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    assert [item["title"] for item in resp.json()] == ["Moved from a finished series"]


async def test_clearing_recurrence_removes_its_occurrence_overrides(auth_client: AsyncClient) -> None:
    """An override describes one occurrence of a series; without the series it describes nothing."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Workout",
        recurrence={"frequency": "daily", "interval": 1, "count": 3},
    )

    override = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={
            "occurrence_start": "2026-04-11T14:00:00+00:00",
            "title": "Moved workout",
            "starts_at": "2026-04-11T18:00:00+00:00",
            "ends_at": "2026-04-11T19:00:00+00:00",
            "cancelled": False,
        },
    )
    assert override.status_code == 200, override.text

    cleared = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"recurrence": None})
    assert cleared.status_code == 200, cleared.text

    # One plain occurrence at the event's own time — no stranded override leaking through.
    resp = await auth_client.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-10T00:00:00+00:00",
            "window_end": "2026-04-14T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert resp.status_code == 200
    occurrences = resp.json()
    assert [item["occurrence_start"] for item in occurrences] == ["2026-04-10T14:00:00Z"]
    assert occurrences[0]["title"] == "Workout"
    assert occurrences[0]["is_exception"] is False


async def test_a_repeating_event_whose_occurrence_outlasts_a_month_is_refused(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    response = await auth_client.post(
        "/api/calendar/events",
        json={
            "title": "Forever",
            "starts_at": "0001-01-01T09:00:00+00:00",
            "ends_at": "2027-01-01T10:00:00+00:00",
            "timezone": "UTC",
            "all_day": False,
            "dashboard_id": dashboard["id"],
            "recurrence": {"frequency": "daily", "interval": 1},
        },
    )
    assert response.status_code == 422
    assert "longer than 31 days" in response.json()["detail"]

    event = await create_calendar_event(auth_client, dashboard["id"], title="Fine")
    response = await auth_client.patch(
        f"/api/calendar/events/{event['id']}",
        json={"ends_at": "2040-01-01T10:00:00+00:00", "recurrence": {"frequency": "daily", "interval": 1}},
    )
    assert response.status_code == 422, response.text


async def test_a_stored_event_that_cannot_expand_is_left_out_not_fatal(client: AsyncClient, db_session: AsyncSession) -> None:
    """The write-time check has not always existed, so the listing must survive a row that predates it."""
    owner = await make_db_user(db_session)
    board = await make_db_dashboard(db_session, owner)
    kept = CalendarEvent(
        dashboard_id=board.id,
        created_by=owner.id,
        updated_by=owner.id,
        title="Kept",
        timezone="UTC",
        all_day=False,
        starts_at=datetime(2026, 9, 7, 9, tzinfo=UTC),
        ends_at=datetime(2026, 9, 7, 10, tzinfo=UTC),
        recurrence=None,
    )
    broken = CalendarEvent(
        dashboard_id=board.id,
        created_by=owner.id,
        updated_by=owner.id,
        title="Broken",
        timezone="UTC",
        all_day=False,
        starts_at=datetime(1, 1, 1, 9, tzinfo=UTC),
        ends_at=datetime(2027, 1, 1, 10, tzinfo=UTC),
        recurrence={"frequency": "daily", "interval": 1},
    )
    db_session.add_all([kept, broken])
    _, raw = await start_session(owner.id, db_session)
    await db_session.flush()
    client.cookies.set(settings.session_cookie_name, raw)
    skipped_before = REGISTRY.get_sample_value("frontdashboard_calendar_expansion_skips_total") or 0

    response = await client.get(
        "/api/calendar/events",
        params={"window_start": "2026-09-06T00:00:00+00:00", "window_end": "2026-09-13T00:00:00+00:00", "dashboard_id": str(board.id)},
    )

    assert response.status_code == 200, response.text
    assert {occurrence["title"] for occurrence in response.json()} == {"Kept"}
    assert REGISTRY.get_sample_value("frontdashboard_calendar_expansion_skips_total") == skipped_before + 1


async def test_a_listing_window_is_capped_at_the_size_the_write_check_covers(auth_client: AsyncClient) -> None:
    """366 days exactly is allowed; one second more is not — the same bound assert_expandable is checked against."""
    dashboard = await create_dashboard(auth_client)
    base = {"dashboard_id": dashboard["id"], "window_start": "2026-01-01T00:00:00+00:00"}
    allowed = await auth_client.get("/api/calendar/events", params={**base, "window_end": "2027-01-02T00:00:00+00:00"})
    assert allowed.status_code == 200, allowed.text
    refused = await auth_client.get("/api/calendar/events", params={**base, "window_end": "2027-01-02T00:00:01+00:00"})
    assert refused.status_code == 422
    assert "366 days" in refused.json()["detail"]


_WEEK = {"window_start": "2026-04-10T00:00:00+00:00", "window_end": "2026-04-17T00:00:00+00:00"}


async def test_a_listing_refuses_more_occurrences_than_one_response_may_carry(auth_client: AsyncClient, monkeypatch) -> None:
    """The cap itself fits and one more does not, and the refusal is an answer rather than a truncated calendar."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 6)
    dashboard = await create_dashboard(auth_client)
    daily = {"frequency": "daily", "interval": 1, "count": 3}
    await create_calendar_event(auth_client, dashboard["id"], title="First", recurrence=daily)
    await create_calendar_event(auth_client, dashboard["id"], title="Second", recurrence=daily)

    at_the_cap = await auth_client.get("/api/calendar/events", params=_WEEK)
    assert at_the_cap.status_code == 200, at_the_cap.text
    assert len(at_the_cap.json()) == 6

    await create_calendar_event(auth_client, dashboard["id"], title="One more")
    before = REGISTRY.get_sample_value("frontdashboard_calendar_listing_refusals_total") or 0.0
    refused = await auth_client.get("/api/calendar/events", params=_WEEK)
    assert refused.status_code == 422
    assert "shorter" in refused.json()["detail"]
    # The only outward sign that someone's calendar stopped loading, so it is part of the refusal.
    assert REGISTRY.get_sample_value("frontdashboard_calendar_listing_refusals_total") == before + 1


async def test_a_listing_past_the_cap_stops_expanding_instead_of_finishing_first(auth_client: AsyncClient, monkeypatch) -> None:
    """The refusal has to come before the work it refuses: the cost is the expansion, not the reply."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 4)
    dashboard = await create_dashboard(auth_client)
    daily = {"frequency": "daily", "interval": 1, "count": 3}
    for index in range(4):
        await create_calendar_event(auth_client, dashboard["id"], title=f"Series {index}", recurrence=daily)

    expanded: list[uuid.UUID] = []
    real = calendar_router.expand_event_occurrences

    def counting(event, *args):
        expanded.append(event.id)
        return real(event, *args)

    monkeypatch.setattr(calendar_router, "expand_event_occurrences", counting)
    refused = await auth_client.get("/api/calendar/events", params=_WEEK)

    assert refused.status_code == 422
    # Three per series against a cap of four: the second series crosses it, so two never run.
    assert len(expanded) == 2


@contextmanager
def _statements(test_database):
    """Every statement the engine runs, so a test can see a bound in the query rather than infer it from the answer."""
    seen: list[str] = []

    def record(_conn, _cursor, statement, *_rest) -> None:
        seen.append(statement)

    engine = test_database.engine.sync_engine
    sa_event.listen(engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        sa_event.remove(engine, "before_cursor_execute", record)


async def test_a_listing_bounds_the_rows_it_loads_in_the_query_itself(auth_client: AsyncClient, monkeypatch, test_database) -> None:
    """The refusal alone would still load every row first; the LIMIT is what keeps them out of memory."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 2)
    dashboard = await create_dashboard(auth_client)
    daily = {"frequency": "daily", "interval": 1, "count": 2}
    event = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence=daily)
    edited = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={"occurrence_start": "2026-04-10T14:00:00+00:00", "title": "Moved"},
    )
    assert edited.status_code == 200, edited.text

    with _statements(test_database) as seen:
        listed = await auth_client.get("/api/calendar/events", params=_WEEK)

    assert listed.status_code == 200, listed.text
    events_query = next(s for s in seen if "FROM calendar_events" in s and "calendar_events.title" in s)
    edits_query = next(s for s in seen if "FROM calendar_event_overrides" in s and "calendar_event_overrides.title" in s)
    assert "LIMIT" in events_query
    assert "LIMIT" in edits_query


async def test_a_listing_refuses_more_rows_than_the_cap_before_expanding_any(auth_client: AsyncClient, monkeypatch) -> None:
    """Exactly the cap is served; one row more is refused without expanding any of them."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 2)
    dashboard = await create_dashboard(auth_client)
    for index in range(2):
        await create_calendar_event(auth_client, dashboard["id"], title=f"One-off {index}")
    assert (await auth_client.get("/api/calendar/events", params=_WEEK)).status_code == 200

    await create_calendar_event(auth_client, dashboard["id"], title="One-off 2")

    def never(*args):
        raise AssertionError("expanded an event the row bound should have refused")

    monkeypatch.setattr(calendar_router, "expand_event_occurrences", never)
    refused = await auth_client.get("/api/calendar/events", params=_WEEK)

    assert refused.status_code == 422


async def _cancel(client: AsyncClient, event_id: str, day: int) -> None:
    edited = await client.patch(
        f"/api/calendar/events/{event_id}/occurrences",
        json={"occurrence_start": f"2026-04-{day:02d}T14:00:00+00:00", "cancelled": True},
    )
    assert edited.status_code == 200, edited.text


async def test_a_listing_refuses_more_edited_occurrences_than_the_cap(auth_client: AsyncClient, monkeypatch) -> None:
    """Cancelled edits keep no occurrence, so only this bound can see them: two fit, a third does not."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 2)
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence={"frequency": "daily", "interval": 1, "count": 3})
    await _cancel(auth_client, event["id"], 10)
    await _cancel(auth_client, event["id"], 11)
    assert (await auth_client.get("/api/calendar/events", params=_WEEK)).status_code == 200

    await _cancel(auth_client, event["id"], 12)
    assert (await auth_client.get("/api/calendar/events", params=_WEEK)).status_code == 422


async def test_edits_outside_the_window_are_not_loaded_with_it(auth_client: AsyncClient, monkeypatch) -> None:
    """One member's edits elsewhere in a series must not be able to refuse everyone's view of this week."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 2)
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence={"frequency": "daily", "interval": 1, "count": 30})
    for day in (20, 21, 22, 23):
        await _cancel(auth_client, event["id"], day)

    # Four edits against a cap of two, all after this window closes on the 12th.
    early = {"window_start": "2026-04-10T00:00:00+00:00", "window_end": "2026-04-12T00:00:00+00:00"}
    listed = await auth_client.get("/api/calendar/events", params=early)

    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == 2


async def test_an_occurrence_moved_out_of_the_window_still_leaves_its_slot_empty(auth_client: AsyncClient) -> None:
    """The edit's new time is outside the window, but its original slot is inside: it must still load to suppress it."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence={"frequency": "daily", "interval": 1, "count": 3})
    moved = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={"occurrence_start": "2026-04-11T14:00:00+00:00", "starts_at": "2026-05-20T14:00:00+00:00", "ends_at": "2026-05-20T15:00:00+00:00"},
    )
    assert moved.status_code == 200, moved.text

    listed = await auth_client.get("/api/calendar/events", params=_WEEK)

    assert listed.status_code == 200, listed.text
    assert [o["occurrence_start"][:10] for o in listed.json()] == ["2026-04-10", "2026-04-12"]


async def test_an_occurrence_moved_into_the_window_is_listed_there(auth_client: AsyncClient) -> None:
    """The mirror case: the original slot is outside the window and only the retimed one is in it."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence={"frequency": "daily", "interval": 1, "count": 3})
    moved = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={"occurrence_start": "2026-04-11T14:00:00+00:00", "starts_at": "2026-05-20T14:00:00+00:00", "ends_at": "2026-05-20T15:00:00+00:00"},
    )
    assert moved.status_code == 200, moved.text

    may = {"window_start": "2026-05-19T00:00:00+00:00", "window_end": "2026-05-22T00:00:00+00:00"}
    listed = await auth_client.get("/api/calendar/events", params=may)

    assert listed.status_code == 200, listed.text
    assert [o["occurrence_start"][:10] for o in listed.json()] == ["2026-05-20"]


async def test_a_listing_refuses_a_walk_longer_than_one_request_may_cost(auth_client: AsyncClient, monkeypatch) -> None:
    """Series that ended before the window keep nothing, so only the walk itself can be counted against them."""
    dashboard = await create_dashboard(auth_client)
    finished = {"frequency": "daily", "interval": 1, "count": 3}
    for index in range(2):
        await create_calendar_event(
            auth_client,
            dashboard["id"],
            title=f"Finished {index}",
            starts_at="2026-03-01T14:00:00+00:00",
            ends_at="2026-03-01T15:00:00+00:00",
            recurrence=finished,
        )

    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_CANDIDATES", 6)
    within = await auth_client.get("/api/calendar/events", params=_WEEK)
    assert within.status_code == 200, within.text
    assert within.json() == []

    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_CANDIDATES", 5)
    refused = await auth_client.get("/api/calendar/events", params=_WEEK)
    assert refused.status_code == 422


async def test_an_event_whose_only_edits_are_elsewhere_is_not_loaded_for_this_window(auth_client: AsyncClient, monkeypatch) -> None:
    """Unwindowed, one edited occurrence would load its ended series for every window there is."""
    dashboard = await create_dashboard(auth_client)
    ended = {"frequency": "daily", "interval": 1, "until": "2026-04-12T23:59:59+00:00"}
    event = await create_calendar_event(auth_client, dashboard["id"], title="Ended", recurrence=ended)
    await _cancel(auth_client, event["id"], 11)

    expanded: list[uuid.UUID] = []
    real = calendar_router.expand_event_occurrences

    def counting(event, *args):
        expanded.append(event.id)
        return real(event, *args)

    monkeypatch.setattr(calendar_router, "expand_event_occurrences", counting)
    june = {"window_start": "2026-06-01T00:00:00+00:00", "window_end": "2026-06-08T00:00:00+00:00"}
    listed = await auth_client.get("/api/calendar/events", params=june)

    assert listed.status_code == 200, listed.text
    assert expanded == []


async def test_an_occurrence_moved_away_leaves_its_old_slot_empty_even_part_way_through_it(auth_client: AsyncClient) -> None:
    """The window opens after the old slot began, so that slot only counts with its length added.

    Moved rather than cancelled on purpose: an edit left in place is found by where it now is, and
    only one that went elsewhere depends on its original slot being matched by its whole span.
    """
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Workshop",
        starts_at="2026-04-10T14:00:00+00:00",
        ends_at="2026-04-10T18:00:00+00:00",
        recurrence={"frequency": "daily", "interval": 1, "count": 3},
    )
    moved = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={"occurrence_start": "2026-04-11T14:00:00+00:00", "starts_at": "2026-05-20T14:00:00+00:00", "ends_at": "2026-05-20T18:00:00+00:00"},
    )
    assert moved.status_code == 200, moved.text

    mid_session = {"window_start": "2026-04-11T15:00:00+00:00", "window_end": "2026-04-11T16:00:00+00:00"}
    listed = await auth_client.get("/api/calendar/events", params=mid_session)

    assert listed.status_code == 200, listed.text
    assert listed.json() == []


async def test_a_cancellation_survives_a_clock_change_between_its_start_and_the_window(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """A three-day occurrence across a DST change, in a session whose zone observes it: the edit must still load."""
    await db_session.execute(text("SET TIME ZONE 'America/New_York'"))
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Retreat",
        starts_at="2026-03-07T12:00:00+00:00",
        ends_at="2026-03-10T12:00:00+00:00",
        recurrence={"frequency": "daily", "interval": 30, "count": 2},
    )
    cancelled = await auth_client.patch(
        f"/api/calendar/events/{event['id']}/occurrences",
        json={"occurrence_start": "2026-03-07T12:00:00+00:00", "cancelled": True},
    )
    assert cancelled.status_code == 200, cancelled.text

    last_half_hour = {"window_start": "2026-03-10T11:30:00+00:00", "window_end": "2026-03-10T11:45:00+00:00"}
    listed = await auth_client.get("/api/calendar/events", params=last_half_hour)

    assert listed.json() == []


@pytest.mark.parametrize(
    ("retime", "window", "expected_start"),
    [
        # Only a start: the end is that start plus the series' hour, and only the tail reaches the window.
        ({"starts_at": datetime(2026, 5, 20, 13, 30, tzinfo=UTC)}, ("2026-05-20T14:00:00+00:00", "2026-05-20T15:00:00+00:00"), "2026-05-20T13:30"),
        # Only an end: the start stays where it was, and the stretched end is what reaches the window.
        ({"ends_at": datetime(2026, 4, 13, 10, tzinfo=UTC)}, ("2026-04-13T09:00:00+00:00", "2026-04-13T09:30:00+00:00"), "2026-04-11T14:00"),
    ],
)
async def test_a_half_retimed_edit_is_loaded_by_the_slot_it_actually_occupies(
    auth_client: AsyncClient, db_session: AsyncSession, retime: dict, window: tuple[str, str], expected_start: str
) -> None:
    """The API writes both ends or neither, but older rows hold one; the query has to fill the other as the expander does."""
    dashboard = await create_dashboard(auth_client)
    created = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence={"frequency": "daily", "interval": 1, "count": 3})
    event = (await db_session.execute(select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(created["id"])))).scalar_one()
    db_session.add(
        CalendarEventOverride(
            calendar_event_id=event.id,
            created_by=event.created_by,
            updated_by=event.created_by,
            occurrence_start=datetime(2026, 4, 11, 14, tzinfo=UTC),
            **retime,
        )
    )
    await db_session.commit()

    listed = await auth_client.get("/api/calendar/events", params={"window_start": window[0], "window_end": window[1]})

    assert listed.status_code == 200, listed.text
    assert [o["occurrence_start"][:16] for o in listed.json()] == [expected_start]


async def test_only_the_edits_of_the_events_being_listed_count_against_the_cap(
    auth_client: AsyncClient, accounts: MemberFactory, monkeypatch
) -> None:
    """Two of mine fit a cap of two; a stranger's edits in the same week, or each of mine counted per event, would not."""
    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_OCCURRENCES", 2)
    daily = {"frequency": "daily", "interval": 1, "count": 1}
    dashboard = await create_dashboard(auth_client)
    for title in ("Mine", "Also mine"):
        event = await create_calendar_event(auth_client, dashboard["id"], title=title, recurrence=daily)
        await _cancel(auth_client, event["id"], 10)

    stranger = await accounts("calendar-stranger@example.com")
    theirs = await create_dashboard(stranger)
    for title in ("Theirs", "Also theirs"):
        event = await create_calendar_event(stranger, theirs["id"], title=title, recurrence=daily)
        await _cancel(stranger, event["id"], 10)

    listed = await auth_client.get("/api/calendar/events", params=_WEEK)

    assert listed.status_code == 200, listed.text


async def test_edits_are_walked_too_and_count_against_the_same_budget(auth_client: AsyncClient, monkeypatch) -> None:
    """Three candidates and two edits are five: an edit outside the generated starts is built like any other."""
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], title="Standup", recurrence={"frequency": "daily", "interval": 1, "count": 3})
    for day in (10, 11):
        edited = await auth_client.patch(
            f"/api/calendar/events/{event['id']}/occurrences",
            json={"occurrence_start": f"2026-04-{day:02d}T14:00:00+00:00", "title": "Renamed"},
        )
        assert edited.status_code == 200, edited.text

    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_CANDIDATES", 5)
    assert (await auth_client.get("/api/calendar/events", params=_WEEK)).status_code == 200

    monkeypatch.setattr(calendar_router, "MAX_RESPONSE_CANDIDATES", 4)
    assert (await auth_client.get("/api/calendar/events", params=_WEEK)).status_code == 422
