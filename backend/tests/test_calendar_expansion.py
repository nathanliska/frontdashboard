"""Occurrence expansion, per frequency (#16).

Unit tests — `expand_event_occurrences` takes plain objects, so none of this needs a database.
That matters because the integration tests in `test_calendar.py` only ever exercise **daily**
recurrence, leaving the weekly, monthly and yearly branches of `_iter_recurrence_starts`
unexercised. Those branches decide whether an event appears on someone's calendar at all, and
getting one wrong is silent: the event is simply absent, and nobody files a bug for something
they cannot see.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

from app.models.calendar import CalendarEvent, CalendarEventOverride
from app.schemas.calendar import CalendarOccurrenceResponse
from app.services.calendar import expand_event_occurrences


def _event(
    *,
    starts_at: datetime,
    ends_at: datetime,
    recurrence: dict | None = None,
    timezone: str = "UTC",
    title: str = "Event",
) -> CalendarEvent:
    actor = uuid.uuid4()
    return CalendarEvent(
        id=uuid.uuid4(),
        dashboard_id=uuid.uuid4(),
        created_by=actor,
        updated_by=actor,
        title=title,
        description=None,
        location=None,
        starts_at=starts_at,
        ends_at=ends_at,
        timezone=timezone,
        all_day=False,
        recurrence=recurrence,
    )


def _override(occurrence_start: datetime, **kwargs) -> CalendarEventOverride:
    actor = uuid.uuid4()
    return CalendarEventOverride(
        id=uuid.uuid4(),
        calendar_event_id=uuid.uuid4(),
        created_by=actor,
        updated_by=actor,
        occurrence_start=occurrence_start,
        **kwargs,
    )


def _starts(event, overrides, window_start, window_end) -> list[str]:
    occurrences = expand_event_occurrences(event, overrides, window_start, window_end)
    return sorted(occurrence.occurrence_start.isoformat() for occurrence in occurrences)


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def test_weekly_expands_every_selected_weekday() -> None:
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),  # a Monday
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [0, 2, 4]},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-04-13T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",  # Mon
        "2026-04-08T09:00:00+00:00",  # Wed
        "2026-04-10T09:00:00+00:00",  # Fri
    ]


def test_weekly_does_not_emit_a_weekday_earlier_in_the_starting_week() -> None:
    """A weekly series must not produce occurrences before it began.

    Weekly expansion anchors on the Monday of the week containing `starts_at`, so the first
    step generates candidates that precede the event itself. Only the start guard stops them,
    and without it a series would appear to have begun before it did.
    """
    event = _event(
        starts_at=_utc("2026-04-08T09:00:00+00:00"),  # a Wednesday
        ends_at=_utc("2026-04-08T09:30:00+00:00"),
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [0, 4]},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-04-18T00:00:00+00:00")) == [
        "2026-04-10T09:00:00+00:00",  # Fri of the starting week — the Mon before it is skipped
        "2026-04-13T09:00:00+00:00",
        "2026-04-17T09:00:00+00:00",
    ]


def test_weekly_interval_skips_the_weeks_between() -> None:
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "weekly", "interval": 2, "by_weekday": [0]},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-05-04T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-20T09:00:00+00:00",
    ]


def test_weekly_skips_ahead_to_a_distant_window_without_walking_every_week() -> None:
    """A years-old weekly series asked for one week in 2026 must land on the right days.

    The skip-ahead arithmetic jumps `week_index` forward rather than iterating; an off-by-one
    there shows up as occurrences on the wrong dates, not as an error.
    """
    event = _event(
        starts_at=_utc("2019-01-07T09:00:00+00:00"),  # a Monday
        ends_at=_utc("2019-01-07T09:30:00+00:00"),
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [0, 4]},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-04-13T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-10T09:00:00+00:00",
    ]


def test_monthly_skips_months_that_have_no_such_day() -> None:
    """The 31st of every month cannot mean the 30th of April.

    `_safe_date` returns None for an impossible date and the month is skipped rather than
    silently sliding to the last valid day — a choice worth pinning, because both behaviours
    are defensible and only one is implemented.
    """
    event = _event(
        starts_at=_utc("2026-01-31T09:00:00+00:00"),
        ends_at=_utc("2026-01-31T10:00:00+00:00"),
        recurrence={"frequency": "monthly", "interval": 1},
    )

    assert _starts(event, {}, _utc("2026-01-01T00:00:00+00:00"), _utc("2026-06-01T00:00:00+00:00")) == [
        "2026-01-31T09:00:00+00:00",
        "2026-03-31T09:00:00+00:00",
        "2026-05-31T09:00:00+00:00",
    ]


def test_yearly_on_a_leap_day_only_lands_on_leap_years() -> None:
    event = _event(
        starts_at=_utc("2024-02-29T09:00:00+00:00"),
        ends_at=_utc("2024-02-29T10:00:00+00:00"),
        recurrence={"frequency": "yearly", "interval": 1},
    )

    assert _starts(event, {}, _utc("2024-01-01T00:00:00+00:00"), _utc("2029-01-01T00:00:00+00:00")) == [
        "2024-02-29T09:00:00+00:00",
        "2028-02-29T09:00:00+00:00",
    ]


def test_count_stops_the_series_even_with_window_left_to_fill() -> None:
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1, "count": 3},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-05-01T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-07T09:00:00+00:00",
        "2026-04-08T09:00:00+00:00",
    ]


def test_count_stops_each_frequency_at_its_own_limit() -> None:
    """Every branch tracks `emitted` separately, so each needs its own stop.

    Weekly is the one worth having: it emits several occurrences per step, so its limit has to
    break out of an inner loop mid-week rather than at a step boundary.
    """
    weekly = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),  # a Monday
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [0, 2, 4], "count": 4},
    )
    assert _starts(weekly, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-06-01T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-08T09:00:00+00:00",
        "2026-04-10T09:00:00+00:00",
        "2026-04-13T09:00:00+00:00",  # stops mid-week, not at the end of one
    ]

    monthly = _event(
        starts_at=_utc("2026-01-15T09:00:00+00:00"),
        ends_at=_utc("2026-01-15T10:00:00+00:00"),
        recurrence={"frequency": "monthly", "interval": 1, "count": 2},
    )
    assert _starts(monthly, {}, _utc("2026-01-01T00:00:00+00:00"), _utc("2027-01-01T00:00:00+00:00")) == [
        "2026-01-15T09:00:00+00:00",
        "2026-02-15T09:00:00+00:00",
    ]

    yearly = _event(
        starts_at=_utc("2026-01-15T09:00:00+00:00"),
        ends_at=_utc("2026-01-15T10:00:00+00:00"),
        recurrence={"frequency": "yearly", "interval": 1, "count": 2},
    )
    assert _starts(yearly, {}, _utc("2026-01-01T00:00:00+00:00"), _utc("2032-01-01T00:00:00+00:00")) == [
        "2026-01-15T09:00:00+00:00",
        "2027-01-15T09:00:00+00:00",
    ]


def test_until_also_accepts_an_aware_datetime_not_only_a_string() -> None:
    """Defensive, and cheap to keep honest.

    Everything the app writes goes through `model_dump(mode="json")`, so `until` is a string in
    every stored row. `_to_utc` handles a real datetime anyway — a test fixture or a rule built
    in memory produces one, and silently ignoring it would drop the bound entirely.
    """
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1, "until": _utc("2026-04-07T09:00:00+00:00")},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-05-01T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-07T09:00:00+00:00",
    ]


def test_until_is_read_from_the_json_string_the_rule_is_stored_as() -> None:
    """`until` arrives as an ISO *string*, because the rule round-trips through JSONB.

    The router's SQL bound casts the same string; this pins the Python side agreeing with it.
    """
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1, "until": "2026-04-08T09:00:00+00:00"},
    )

    assert _starts(event, {}, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-05-01T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-07T09:00:00+00:00",
        "2026-04-08T09:00:00+00:00",
    ]


def test_a_cancelled_occurrence_leaves_a_hole_in_the_series() -> None:
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1},
    )
    overrides = {_utc("2026-04-07T09:00:00+00:00"): _override(_utc("2026-04-07T09:00:00+00:00"), cancelled=True)}

    assert _starts(event, overrides, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-04-09T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-08T09:00:00+00:00",
    ]


def test_an_occurrence_moved_into_the_window_is_found_for_every_frequency() -> None:
    """The override-collection fix has to hold for all four branches, not just daily.

    The iterator walks the requested window, so an override whose *original* start sits outside
    it is never generated by any of the four. Daily is covered by an integration test; monthly
    and yearly reach the window through completely separate code paths, and a series that only
    steps once a year is exactly where a moved occurrence is most likely to be the only thing
    the user expects to see.
    """
    for frequency, original in (
        ("weekly", "2026-01-05T09:00:00+00:00"),
        ("monthly", "2026-01-05T09:00:00+00:00"),
        ("yearly", "2026-01-05T09:00:00+00:00"),
    ):
        rule: dict = {"frequency": frequency, "interval": 1}
        if frequency == "weekly":
            rule["by_weekday"] = [0]
        event = _event(
            starts_at=_utc("2026-01-05T09:00:00+00:00"),  # a Monday
            ends_at=_utc("2026-01-05T10:00:00+00:00"),
            recurrence=rule,
        )
        overrides = {
            _utc(original): _override(
                _utc(original),
                starts_at=_utc("2026-04-10T14:00:00+00:00"),
                ends_at=_utc("2026-04-10T15:00:00+00:00"),
            )
        }

        occurrences = expand_event_occurrences(
            event,
            overrides,
            _utc("2026-04-10T00:00:00+00:00"),
            _utc("2026-04-11T00:00:00+00:00"),
        )
        moved = [o for o in occurrences if o.original_start == _utc(original)]
        assert len(moved) == 1, f"{frequency}: the moved occurrence went missing"
        assert moved[0].occurrence_start == _utc("2026-04-10T14:00:00+00:00")
        assert moved[0].is_exception is True


def test_a_moved_occurrence_is_not_also_shown_at_its_original_time() -> None:
    """Collecting the override must not duplicate an occurrence the window already generated."""
    event = _event(
        starts_at=_utc("2026-04-06T09:00:00+00:00"),
        ends_at=_utc("2026-04-06T09:30:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1},
    )
    original = _utc("2026-04-07T09:00:00+00:00")
    overrides = {
        original: _override(
            original,
            starts_at=_utc("2026-04-07T15:00:00+00:00"),
            ends_at=_utc("2026-04-07T15:30:00+00:00"),
        )
    }

    assert _starts(event, overrides, _utc("2026-04-06T00:00:00+00:00"), _utc("2026-04-09T00:00:00+00:00")) == [
        "2026-04-06T09:00:00+00:00",
        "2026-04-07T15:00:00+00:00",  # retimed, and present exactly once
        "2026-04-08T09:00:00+00:00",
    ]


def test_a_daylight_saving_shift_keeps_the_local_wall_time() -> None:
    """Occurrences are generated from a local date + local time, not by adding 24h in UTC.

    A 09:00 standup stays at 09:00 across a DST boundary, which means its UTC offset moves. The
    whole reason `_iter_recurrence_starts` works in the event's own zone.
    """
    event = _event(
        starts_at=_utc("2026-03-06T14:00:00+00:00"),  # 09:00 America/New_York, EST
        ends_at=_utc("2026-03-06T14:30:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1},
        timezone="America/New_York",
    )

    starts = _starts(event, {}, _utc("2026-03-06T00:00:00+00:00"), _utc("2026-03-11T00:00:00+00:00"))
    # US DST began 2026-03-08, so the last two are 13:00Z rather than 14:00Z.
    assert starts == [
        "2026-03-06T14:00:00+00:00",
        "2026-03-07T14:00:00+00:00",
        "2026-03-08T13:00:00+00:00",
        "2026-03-09T13:00:00+00:00",
        "2026-03-10T13:00:00+00:00",
    ]


def test_a_long_occurrence_straddling_the_window_start_is_kept() -> None:
    """`_overlaps` compares the occurrence's *end*, so an overnight shift already underway shows."""
    event = _event(
        starts_at=_utc("2026-04-06T22:00:00+00:00"),
        ends_at=_utc("2026-04-07T06:00:00+00:00"),
        recurrence={"frequency": "daily", "interval": 1},
    )

    starts = _starts(event, {}, _utc("2026-04-08T00:00:00+00:00"), _utc("2026-04-08T12:00:00+00:00"))
    assert starts == ["2026-04-07T22:00:00+00:00"]


def test_a_one_off_event_expands_to_exactly_itself() -> None:
    event = _event(
        starts_at=_utc("2026-04-10T09:00:00+00:00"),
        ends_at=_utc("2026-04-10T10:00:00+00:00"),
    )

    occurrences = expand_event_occurrences(
        event,
        {},
        _utc("2026-04-10T00:00:00+00:00"),
        _utc("2026-04-11T00:00:00+00:00"),
    )
    assert len(occurrences) == 1
    assert occurrences[0].recurring is False
    assert occurrences[0].is_exception is False
    assert occurrences[0].occurrence_end - occurrences[0].occurrence_start == timedelta(hours=1)


def test_every_serialized_datetime_is_utc_z_form() -> None:
    """The client parses these with `z.iso.datetime()`, which accepts `Z` and rejects offset form.

    Expansion is the only place doing timezone arithmetic, so it is the only place a local-zone
    datetime could reach Pydantic — where it serializes as `+HH:MM` and fails validation at the
    boundary for the whole response, rather than showing a wrong time (ADR-018).
    """
    event = _event(
        starts_at=_utc("2026-03-06T15:00:00+00:00"),
        ends_at=_utc("2026-03-06T15:30:00+00:00"),
        timezone="America/Chicago",
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [4]},
    )

    occurrences = expand_event_occurrences(event, {}, _utc("2026-03-01T00:00:00+00:00"), _utc("2026-03-31T00:00:00+00:00"))
    # Spans the 8 March transition, so the event's local offset is not the same for every occurrence.
    assert len(occurrences) >= 3

    for occurrence in occurrences:
        body = json.loads(CalendarOccurrenceResponse.model_validate(occurrence, from_attributes=True).model_dump_json())
        for field in ("occurrence_start", "occurrence_end", "original_start"):
            assert body[field].endswith("Z"), f"{field} serialized as {body[field]}, which the client rejects"
