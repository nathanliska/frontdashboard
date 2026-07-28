"""All-day events snap to whole local days.

Unit tests — `normalize_all_day_bounds` is pure, so none of this needs a database.

`all_day` used to be a passthrough flag: whatever times the client sent were stored, so production
ended up with all-day events starting at 09:00 local. The end was already local midnight, which is
why nothing visibly broke — the window predicate compares against `ends_at`. The agenda sorts by
`starts_at` though, so those events sorted among the timed ones instead of at the top of the day.
"""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from app.services.calendar import normalize_all_day_bounds

NY = "America/New_York"


def _local(timezone: str, text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(timezone))


def test_a_start_mid_morning_snaps_back_to_local_midnight() -> None:
    """The production case: 16 of 25 all-day events started at 09:00 local."""
    starts, ends = normalize_all_day_bounds(
        _local(NY, "2026-07-25T09:00:00"),
        _local(NY, "2026-07-26T00:00:00"),
        NY,
    )

    assert starts == _local(NY, "2026-07-25T00:00:00")
    assert ends == _local(NY, "2026-07-26T00:00:00")


def test_normalizing_twice_changes_nothing() -> None:
    """Idempotency is the property the microsecond step-back exists for.

    The end is exclusive, so an event covering 25 July ends at midnight on the 26th. Truncating
    that end to its own day would say "the 26th" and add a day — every edit to an all-day event
    would then stretch it by one more. Stepping back a microsecond before truncating keeps a
    midnight end on the day it actually closes.
    """
    first = normalize_all_day_bounds(_local(NY, "2026-07-25T09:00:00"), _local(NY, "2026-07-26T00:00:00"), NY)
    second = normalize_all_day_bounds(*first, NY)
    third = normalize_all_day_bounds(*second, NY)

    assert first == second == third


def test_a_multi_day_event_keeps_every_day_it_covers() -> None:
    starts, ends = normalize_all_day_bounds(
        _local(NY, "2026-07-25T13:30:00"),
        _local(NY, "2026-07-28T16:45:00"),
        NY,
    )

    # Ends exclusive on the 29th: the event covers the 25th through the 28th inclusive.
    assert starts == _local(NY, "2026-07-25T00:00:00")
    assert ends == _local(NY, "2026-07-29T00:00:00")


def test_a_single_day_never_collapses_to_zero_length() -> None:
    """`ends_at > starts_at` is a CHECK constraint — normalization must not be able to violate it."""
    starts, ends = normalize_all_day_bounds(
        _local(NY, "2026-07-25T09:00:00"),
        _local(NY, "2026-07-25T09:30:00"),
        NY,
    )

    assert starts == _local(NY, "2026-07-25T00:00:00")
    assert ends == _local(NY, "2026-07-26T00:00:00")
    assert ends > starts


def test_a_spring_forward_day_is_still_one_local_day() -> None:
    """2026-03-08 is 23 hours long in New York. The result must be one local day, not 24 hours."""
    starts, ends = normalize_all_day_bounds(
        _local(NY, "2026-03-08T09:00:00"),
        _local(NY, "2026-03-09T00:00:00"),
        NY,
    )

    assert starts == _local(NY, "2026-03-08T00:00:00")
    assert ends == _local(NY, "2026-03-09T00:00:00")
    assert (ends - starts).total_seconds() == 23 * 3600


def test_a_fall_back_day_is_still_one_local_day() -> None:
    """2026-11-01 is 25 hours long in New York."""
    starts, ends = normalize_all_day_bounds(
        _local(NY, "2026-11-01T09:00:00"),
        _local(NY, "2026-11-02T00:00:00"),
        NY,
    )

    assert (ends - starts).total_seconds() == 25 * 3600


def test_the_local_day_is_the_events_own_timezone_not_utc() -> None:
    """22:00 in New York is already the next day in UTC — snapping in UTC would pick the wrong day."""
    starts, ends = normalize_all_day_bounds(
        _local(NY, "2026-07-25T22:00:00"),  # 2026-07-26T02:00Z
        _local(NY, "2026-07-26T00:00:00"),
        NY,
    )

    assert starts.astimezone(UTC) == _local(NY, "2026-07-25T00:00:00").astimezone(UTC)
    assert starts.astimezone(ZoneInfo(NY)).day == 25
    assert ends.astimezone(ZoneInfo(NY)).day == 26
