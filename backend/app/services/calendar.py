import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.models.calendar import CalendarEvent, CalendarEventOverride


@dataclass(slots=True)
class ExpandedOccurrence:
    event_id: uuid.UUID
    occurrence_start: datetime
    occurrence_end: datetime
    original_start: datetime
    title: str
    description: str | None
    location: str | None
    timezone: str
    all_day: bool
    created_by: uuid.UUID
    recurring: bool
    is_exception: bool


def expand_event_occurrences(
    event: CalendarEvent,
    overrides_by_start: dict[datetime, CalendarEventOverride],
    window_start: datetime,
    window_end: datetime,
) -> list[ExpandedOccurrence]:
    duration = event.ends_at - event.starts_at
    starts = [event.starts_at] if not event.recurrence else list(_iter_recurrence_starts(event, window_start, window_end))

    # An override can retime an occurrence *into* this window from an original start outside it —
    # "move next Tuesday's meeting to next month". The iterator above walks the window rather than
    # the series, so that original start is never generated, and overrides are keyed by it: without
    # this the moved occurrence is missing from every window that does not contain its origin date.
    generated = set(starts)
    starts = [*starts, *(start for start in overrides_by_start if start not in generated)]

    occurrences: list[ExpandedOccurrence] = []
    for start in starts:
        occurrence = _build_occurrence(event, overrides_by_start.get(start), start, duration)
        if occurrence is None:
            continue
        if _overlaps(occurrence.occurrence_start, occurrence.occurrence_end, window_start, window_end):
            occurrences.append(occurrence)

    return occurrences


def _build_occurrence(
    event: CalendarEvent,
    override: CalendarEventOverride | None,
    original_start: datetime,
    duration: timedelta,
) -> ExpandedOccurrence | None:
    if override and override.cancelled:
        return None

    occurrence_start = override.starts_at if override and override.starts_at is not None else original_start
    occurrence_end = override.ends_at if override and override.ends_at is not None else occurrence_start + duration

    return ExpandedOccurrence(
        event_id=event.id,
        occurrence_start=occurrence_start,
        occurrence_end=occurrence_end,
        original_start=original_start,
        title=override.title if override and override.title is not None else event.title,
        description=override.description if override and override.description is not None else event.description,
        location=override.location if override and override.location is not None else event.location,
        timezone=override.timezone if override and override.timezone is not None else event.timezone,
        all_day=override.all_day if override and override.all_day is not None else event.all_day,
        created_by=event.created_by,
        recurring=event.recurrence is not None,
        is_exception=override is not None,
    )


def _iter_recurrence_starts(event: CalendarEvent, window_start: datetime, window_end: datetime):
    rule = event.recurrence or {}
    frequency = str(rule["frequency"])
    interval = int(rule.get("interval", 1))
    count_limit = int(rule["count"]) if rule.get("count") is not None else None
    until = _to_utc(rule.get("until"))

    tz = ZoneInfo(event.timezone)
    base_local = event.starts_at.astimezone(tz)
    local_time = time(
        hour=base_local.hour,
        minute=base_local.minute,
        second=base_local.second,
        microsecond=base_local.microsecond,
    )

    emitted = 0

    def should_emit(candidate_utc: datetime) -> bool:
        nonlocal emitted
        if candidate_utc < event.starts_at:
            return False
        if until is not None and candidate_utc > until:
            return False
        if count_limit is not None and emitted >= count_limit:
            return False
        emitted += 1
        return True

    if frequency == "daily":
        # Skip ahead to near window_start when there's no count limit (count-limited
        # events must iterate from the beginning to track emitted correctly).
        if count_limit is None and window_start > event.starts_at:
            days_ahead = (window_start.date() - base_local.date()).days
            # Step back enough intervals to cover the event duration, so occurrences
            # that started before window_start but extend into it are not missed.
            duration_days = (event.ends_at - event.starts_at).days
            intervals_back = max(1, (duration_days + interval - 1) // interval)
            intervals_to_skip = max(0, (days_ahead // interval) - intervals_back)
            current_date = base_local.date() + timedelta(days=intervals_to_skip * interval)
        else:
            current_date = base_local.date()
        while True:
            candidate_utc = _local_to_utc(tz, current_date, local_time)
            if candidate_utc >= window_end:
                break
            if should_emit(candidate_utc):
                yield candidate_utc
            elif count_limit is not None and emitted >= count_limit:
                break
            current_date += timedelta(days=interval)
        return

    if frequency == "weekly":
        weekdays = sorted(set(int(day) for day in rule.get("by_weekday", [base_local.weekday()])))
        week_start = base_local.date() - timedelta(days=base_local.weekday())
        # Skip ahead to near window_start when there's no count limit.
        if count_limit is None and window_start > event.starts_at:
            days_ahead = max(0, (window_start.date() - week_start).days)
            duration_days = (event.ends_at - event.starts_at).days
            intervals_back = max(1, (duration_days + 7 * interval - 1) // (7 * interval))
            week_index = max(0, (days_ahead // (7 * interval)) - intervals_back)
        else:
            week_index = 0
        while True:
            current_week_start = week_start + timedelta(weeks=week_index * interval)
            for weekday in weekdays:
                candidate_date = current_week_start + timedelta(days=weekday)
                candidate_utc = _local_to_utc(tz, candidate_date, local_time)
                if candidate_utc >= window_end:
                    return
                if should_emit(candidate_utc):
                    yield candidate_utc
                elif count_limit is not None and emitted >= count_limit:
                    return
            week_index += 1

    if frequency == "monthly":
        months_added = 0
        while True:
            year, month = _add_months(base_local.year, base_local.month, months_added)
            candidate_date = _safe_date(year, month, base_local.day)
            months_added += interval
            if candidate_date is None:
                continue
            candidate_utc = _local_to_utc(tz, candidate_date, local_time)
            if candidate_utc >= window_end:
                break
            if should_emit(candidate_utc):
                yield candidate_utc
            elif count_limit is not None and emitted >= count_limit:
                break
        return

    if frequency == "yearly":
        years_added = 0
        while True:
            candidate_date = _safe_date(base_local.year + years_added, base_local.month, base_local.day)
            years_added += interval
            if candidate_date is None:
                continue
            candidate_utc = _local_to_utc(tz, candidate_date, local_time)
            if candidate_utc >= window_end:
                break
            if should_emit(candidate_utc):
                yield candidate_utc
            elif count_limit is not None and emitted >= count_limit:
                break


def normalize_all_day_bounds(starts_at: datetime, ends_at: datetime, timezone: str) -> tuple[datetime, datetime]:
    """Snap an all-day event to whole local days.

    `all_day` was a passthrough flag: whatever times the client sent were stored verbatim, so
    production accumulated "all-day" events starting at 09:00 — 20 of 25 of them. Nothing broke,
    because the window predicate compares against `ends_at` and that was already local midnight,
    but the agenda sorts by `starts_at` and so filed them among the timed events instead of at the
    top of the day. More to the point, the flag did not mean what it says, which is a trap for the
    next person who trusts it.

    The end is **exclusive** — an event covering one day ends at local midnight on the next. That
    is the convention the existing rows already follow, so this preserves them rather than shifting
    everything by a day. A sub-microsecond step back before truncating is what makes it stable:
    without it, re-normalizing an already-normalized event would extend it by a day each time.

    Conversion goes through the event's own timezone, so a day that is 23 or 25 hours long across a
    DST boundary still maps to exactly one local day.
    """
    tz = ZoneInfo(timezone)
    start_local = starts_at.astimezone(tz)
    end_local = ends_at.astimezone(tz)

    first_day = start_local.date()
    # An end already at local midnight belongs to the previous day; stepping back keeps it there.
    last_day = (end_local - timedelta(microseconds=1)).date()
    if last_day < first_day:
        last_day = first_day

    return (
        _local_to_utc(tz, first_day, time.min),
        _local_to_utc(tz, last_day + timedelta(days=1), time.min),
    )


def _local_to_utc(tz: ZoneInfo, local_date: date, local_time: time) -> datetime:
    return datetime.combine(local_date, local_time, tzinfo=tz).astimezone(UTC)


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _add_months(year: int, month: int, months_added: int) -> tuple[int, int]:
    total_months = (month - 1) + months_added
    return year + (total_months // 12), (total_months % 12) + 1


def _overlaps(start: datetime, end: datetime, window_start: datetime, window_end: datetime) -> bool:
    return start < window_end and end > window_start


def _to_utc(value: object | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        return datetime.fromisoformat(value).astimezone(UTC)
    if isinstance(value, datetime):
        return value.astimezone(UTC)
    return None
