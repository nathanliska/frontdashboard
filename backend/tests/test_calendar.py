import uuid

import pytest
from httpx import AsyncClient

from app.routers import calendar as calendar_router
from tests.helpers import create_calendar_event, create_dashboard, register_client, set_csrf, share_dashboard


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
        await share_dashboard(auth_client, dashboard["id"], client, "viewer")

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

    set_csrf(auth_client)
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
    set_csrf(auth_client)
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

    set_csrf(auth_client)
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

    set_csrf(auth_client)
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
