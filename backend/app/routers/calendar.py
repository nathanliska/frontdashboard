import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import DateTime, and_, cast, delete, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.config import settings
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
from app.models.calendar import CalendarEvent, CalendarEventOverride, CalendarEventParticipant
from app.models.dashboard import Dashboard
from app.models.share import EffectiveRole, ResourceShare
from app.models.user import User
from app.schemas.calendar import (
    CalendarEventCreate,
    CalendarEventParticipantResponse,
    CalendarEventResponse,
    CalendarEventUpdate,
    CalendarOccurrenceMutationResponse,
    CalendarOccurrenceResponse,
    CalendarOccurrenceUpdate,
    RecurrenceRule,
    TrashedEventCursor,
    TrashedEventPage,
    TrashedEventSummary,
)
from app.schemas.shares import InheritedDashboardAccessResponse, ResourceAccessResponse
from app.services import permissions
from app.services.activity import EventType, log_event
from app.services.calendar import expand_event_occurrences, normalize_all_day_bounds
from app.services.quota import assert_under_quota, limit_message
from app.services.shares import (
    dashboard_audience_user_ids,
    list_accessible_dashboard_ids,
    load_dashboard_access,
)
from app.sse.choreography import ClientIdHeader, Fanout, commit_and_broadcast
from app.sse.events import build_activity_sse_dict

router = APIRouter(prefix="/calendar", tags=["calendar"])

# One page of the trash. Nothing on the client mirrors this — the response names the next cursor.
_TRASH_PAGE_SIZE = 200


def _echo_stamp(client_id: str | None) -> dict[str, str]:
    """The payload field the issuing tab matches its own echo on; absent when the write carried none."""
    return {} if client_id is None else {"origin_client_id": client_id}


def _dashboard_fanout(message: dict, dashboard: Dashboard, shares: list[ResourceShare]) -> Fanout:
    """Address a frame to everyone who can see the dashboard, owner included."""
    return Fanout(message, dashboard_audience_user_ids(dashboard, shares))


async def _get_event_access(
    event_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[CalendarEvent, Dashboard, list[ResourceShare], EffectiveRole]:
    result = await db.execute(select(CalendarEvent).where(CalendarEvent.id == event_id, CalendarEvent.deleted_at.is_(None)))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    dashboard, shares, role = await load_dashboard_access(event.dashboard_id, user, db)
    return event, dashboard, shares, role


async def _replace_participants(
    db: AsyncSession,
    event: CalendarEvent,
    user_ids: list[uuid.UUID],
    dashboard: Dashboard,
    shares: list[ResourceShare],
) -> None:
    """Replace the event's participant set, refusing any newcomer who is not a member.

    Ids already on the event stay legal even after an unshare — otherwise the first edit after a
    departure would force dropping the departed member, the silent rewrite FDR-006 rules out.
    """
    existing_result = await db.execute(select(CalendarEventParticipant.user_id).where(CalendarEventParticipant.calendar_event_id == event.id))
    existing_ids = set(existing_result.scalars().all())
    outsiders = set(user_ids) - existing_ids - dashboard_audience_user_ids(dashboard, shares)
    if outsiders:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Participants must be members of the dashboard",
        )
    await db.execute(delete(CalendarEventParticipant).where(CalendarEventParticipant.calendar_event_id == event.id))
    db.add_all(CalendarEventParticipant(calendar_event_id=event.id, user_id=user_id) for user_id in dict.fromkeys(user_ids))


async def _participants_by_event(
    db: AsyncSession,
    event_ids: set[uuid.UUID],
) -> dict[uuid.UUID, list[CalendarEventParticipantResponse]]:
    """Resolve participants with display names, ordered by name, for a batch of events."""
    participants: dict[uuid.UUID, list[CalendarEventParticipantResponse]] = {}
    if not event_ids:
        return participants
    rows = await db.execute(
        select(CalendarEventParticipant.calendar_event_id, User.id, User.display_name)
        .join(User, User.id == CalendarEventParticipant.user_id)
        .where(CalendarEventParticipant.calendar_event_id.in_(event_ids))
        .order_by(func.lower(User.display_name))
    )
    for event_id, user_id, display_name in rows.all():
        participants.setdefault(event_id, []).append(CalendarEventParticipantResponse(user_id=user_id, display_name=display_name))
    return participants


def _event_response(event: CalendarEvent, participants: list[CalendarEventParticipantResponse]) -> CalendarEventResponse:
    return CalendarEventResponse(
        id=event.id,
        dashboard_id=event.dashboard_id,
        title=event.title,
        description=event.description,
        location=event.location,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        timezone=event.timezone,
        all_day=event.all_day,
        created_by=event.created_by,
        updated_by=event.updated_by,
        recurrence=RecurrenceRule.model_validate(event.recurrence) if event.recurrence else None,
        participants=participants,
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def _occurrence_response(occurrence, participants: list[CalendarEventParticipantResponse]) -> CalendarOccurrenceResponse:
    return CalendarOccurrenceResponse(
        event_id=occurrence.event_id,
        occurrence_start=occurrence.occurrence_start,
        occurrence_end=occurrence.occurrence_end,
        original_start=occurrence.original_start,
        title=occurrence.title,
        description=occurrence.description,
        location=occurrence.location,
        timezone=occurrence.timezone,
        all_day=occurrence.all_day,
        created_by=occurrence.created_by,
        recurring=occurrence.recurring,
        is_exception=occurrence.is_exception,
        participants=participants,
    )


def _dashboard_managed_permissions_response(dashboard: Dashboard) -> ResourceAccessResponse:
    return ResourceAccessResponse(
        direct_shares=[],
        inherited_dashboards=[InheritedDashboardAccessResponse(dashboard_id=dashboard.id, dashboard_name=dashboard.name)],
    )


def _raise_dashboard_managed_permissions_error() -> None:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Event permissions are managed on the parent dashboard",
    )


@router.post("/events", status_code=status.HTTP_201_CREATED, response_model=CalendarEventResponse)
@limiter.limit(WRITE_LIMIT)
async def create_event(
    request: Request,
    body: CalendarEventCreate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    """Create a calendar event on an accessible dashboard."""
    dashboard, shares, role = await load_dashboard_access(body.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)
    await assert_under_quota(
        db,
        model=CalendarEvent,
        resource="events",
        cap=settings.quota_events_per_user,
        scope=CalendarEvent.created_by == current_user.id,
        detail=limit_message("calendar events", settings.quota_events_per_user, reclaim="expiry"),
    )
    await assert_under_quota(
        db,
        model=CalendarEvent,
        resource="events",
        cap=settings.quota_events_per_dashboard,
        scope=CalendarEvent.dashboard_id == dashboard.id,
        detail=limit_message("events on this dashboard", settings.quota_events_per_dashboard, reclaim="expiry"),
    )

    starts_at = body.starts_at.astimezone(UTC)
    ends_at = body.ends_at.astimezone(UTC)
    if body.all_day:
        starts_at, ends_at = normalize_all_day_bounds(starts_at, ends_at, body.timezone)

    event = CalendarEvent(
        dashboard_id=dashboard.id,
        created_by=current_user.id,
        updated_by=current_user.id,
        title=body.title,
        description=body.description,
        location=body.location,
        starts_at=starts_at,
        ends_at=ends_at,
        timezone=body.timezone,
        all_day=body.all_day,
        recurrence=body.recurrence.model_dump(mode="json") if body.recurrence else None,
    )
    db.add(event)
    await db.flush()
    await _replace_participants(db, event, body.participants, dashboard, shares)

    activity = log_event(
        db,
        event_type=EventType.calendar_event_created,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "recurring": event.recurrence is not None, "dashboard_id": str(dashboard.id)} | _echo_stamp(client_id),
    )
    event_message = await build_activity_sse_dict(db, activity)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(event)
    return _event_response(event, (await _participants_by_event(db, {event.id})).get(event.id, []))


@router.get("/events", response_model=list[CalendarOccurrenceResponse])
async def list_occurrences(
    window_start: datetime,
    window_end: datetime,
    dashboard_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CalendarOccurrenceResponse]:
    """List expanded event occurrences for the requested window."""
    if window_start.tzinfo is None or window_start.utcoffset() is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="window_start must be timezone-aware")
    if window_end.tzinfo is None or window_end.utcoffset() is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="window_end must be timezone-aware")
    if window_end <= window_start:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="window_end must be after window_start")
    if window_end - window_start > timedelta(days=366):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="window cannot exceed 366 days")

    accessible_dashboard_ids = await list_accessible_dashboard_ids(current_user, db)
    if not accessible_dashboard_ids:
        return []

    if dashboard_id is not None and dashboard_id not in accessible_dashboard_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    dashboard_ids = [dashboard_id] if dashboard_id is not None else accessible_dashboard_ids
    window_start = window_start.astimezone(UTC)
    window_end = window_end.astimezone(UTC)

    # Load only what could land in the window, so viewing next week doesn't cost the whole history.
    # A series is bounded by `starts_at` and, when the rule carries `until`, `until + duration`.
    # Series without `until` still load unbounded — finding a `count` end means expanding the rule.
    series_duration = CalendarEvent.ends_at - CalendarEvent.starts_at
    series_until = cast(CalendarEvent.recurrence["until"].astext, DateTime(timezone=True))
    # `jsonb_typeof` rather than IS NOT NULL: JSONB can hold the scalar 'null', which passes an
    # IS NOT NULL test and would read as an unbounded series.
    recurring_in_window = and_(
        func.jsonb_typeof(CalendarEvent.recurrence) == "object",
        CalendarEvent.starts_at < window_end,
        or_(
            CalendarEvent.recurrence["until"].astext.is_(None),
            series_until + series_duration > window_start,
        ),
    )
    has_override = select(CalendarEventOverride.id).where(CalendarEventOverride.calendar_event_id == CalendarEvent.id).exists()
    result = await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.dashboard_id.in_(dashboard_ids),
            or_(
                recurring_in_window,
                (CalendarEvent.starts_at < window_end) & (CalendarEvent.ends_at > window_start),
                # Deliberately unbounded, which is what makes the bounds above safe: an override
                # can move an occurrence outside its event's own times.
                has_override,
            ),
        )
    )
    events = list(result.scalars().all())
    if not events:
        return []

    event_ids = [event.id for event in events]
    overrides_result = await db.execute(select(CalendarEventOverride).where(CalendarEventOverride.calendar_event_id.in_(event_ids)))
    overrides = list(overrides_result.scalars().all())
    overrides_by_event: dict[uuid.UUID, dict[datetime, CalendarEventOverride]] = {event.id: {} for event in events}
    for override in overrides:
        overrides_by_event.setdefault(override.calendar_event_id, {})[override.occurrence_start] = override

    occurrences = []
    for event in events:
        occurrences.extend(
            expand_event_occurrences(
                event,
                overrides_by_event.get(event.id, {}),
                window_start,
                window_end,
            )
        )

    occurrences.sort(key=lambda occurrence: (occurrence.occurrence_start, occurrence.title.lower()))
    participants = await _participants_by_event(db, {occurrence.event_id for occurrence in occurrences})
    return [_occurrence_response(occurrence, participants.get(occurrence.event_id, [])) for occurrence in occurrences]


# Declared above `/events/{event_id}`: FastAPI matches in definition order, so below it "trash"
# is read as an event id and answers 422 instead of this listing. A test pins the ordering.
@router.get("/events/trash", response_model=TrashedEventPage)
async def event_trash(
    dashboard_id: uuid.UUID | None = Query(default=None),
    before: datetime | None = Query(default=None),
    before_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TrashedEventPage:
    """One page of trashed events the caller can see, newest first, with their purge deadline.

    Scoped by dashboard access, not authorship: whoever can edit the dashboard put it there and can
    take it back. Events under a trashed dashboard are excluded — they return with it.

    Paged by cursor, not offset: the caller restores and purges from this very list, so an offset
    would slide rows across the page boundary and skip them. `before`/`before_id` are the last row
    of the previous page and must be given together.
    """
    if (before is None) != (before_id is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="before and before_id must be given together",
        )
    # A naive value would be read as UTC and page from the wrong instant, skipping rows — the one
    # failure a recovery list may not have. The window params above reject naive for the same reason.
    if before is not None and (before.tzinfo is None or before.utcoffset() is None):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="before must be timezone-aware")

    accessible_dashboard_ids = await list_accessible_dashboard_ids(current_user, db)
    if not accessible_dashboard_ids:
        return TrashedEventPage(items=[])

    if dashboard_id is not None:
        if dashboard_id not in accessible_dashboard_ids:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
        dashboard_ids = [dashboard_id]
    else:
        dashboard_ids = accessible_dashboard_ids

    # `id` breaks ties on identical deleted_at — without it the sort is not total and a cursor can
    # step over or repeat rows deleted in the same transaction.
    stmt = (
        select(CalendarEvent)
        .where(CalendarEvent.deleted_at.is_not(None), CalendarEvent.dashboard_id.in_(dashboard_ids))
        .order_by(CalendarEvent.deleted_at.desc(), CalendarEvent.id.desc())
        # One past the page: whether the extra row came back is what decides `next_cursor`, so the
        # client is told there is more rather than inferring it from a page size it has to mirror.
        .limit(_TRASH_PAGE_SIZE + 1)
    )
    if before is not None and before_id is not None:
        stmt = stmt.where(tuple_(CalendarEvent.deleted_at, CalendarEvent.id) < (before, before_id))

    result = await db.execute(stmt)
    events = list(result.scalars().all())
    has_more = len(events) > _TRASH_PAGE_SIZE
    del events[_TRASH_PAGE_SIZE:]

    retention = timedelta(days=settings.trash_retention_days)
    summaries: list[TrashedEventSummary] = []
    for event in events:
        # The WHERE guarantees deleted_at; the assert narrows the Optional for the type checker.
        assert event.deleted_at is not None
        summaries.append(
            TrashedEventSummary(
                id=event.id,
                dashboard_id=event.dashboard_id,
                title=event.title,
                starts_at=event.starts_at,
                recurring=event.recurrence is not None,
                deleted_at=event.deleted_at,
                purge_at=event.deleted_at + retention,
            )
        )

    last = summaries[-1] if summaries else None
    next_cursor = TrashedEventCursor(deleted_at=last.deleted_at, id=last.id) if has_more and last else None
    return TrashedEventPage(items=summaries, next_cursor=next_cursor)


@router.get("/events/{event_id}", response_model=CalendarEventResponse)
async def get_event(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    """Return a single calendar event the caller can access."""
    event, _dashboard, _shares, _role = await _get_event_access(event_id, current_user, db)
    return _event_response(event, (await _participants_by_event(db, {event.id})).get(event.id, []))


@router.patch("/events/{event_id}", response_model=CalendarEventResponse)
@limiter.limit(WRITE_LIMIT)
async def update_event(
    request: Request,
    event_id: uuid.UUID,
    body: CalendarEventUpdate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    """Update calendar event metadata and broadcast the change."""
    event, dashboard, shares, role = await _get_event_access(event_id, current_user, db)
    permissions.assert_can_edit(role)

    if body.title is not None:
        event.title = body.title
    if "description" in body.model_fields_set:
        event.description = body.description
    if "location" in body.model_fields_set:
        event.location = body.location
    if body.starts_at is not None:
        event.starts_at = body.starts_at.astimezone(UTC)
    if body.ends_at is not None:
        event.ends_at = body.ends_at.astimezone(UTC)
    if event.ends_at <= event.starts_at:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="ends_at must be after starts_at")
    if body.timezone is not None:
        event.timezone = body.timezone
    if body.all_day is not None:
        event.all_day = body.all_day
    if event.all_day:
        # After every field is settled: the snap depends on the timezone, which this same request
        # may have just changed. Turning all_day *off* deliberately leaves the times alone.
        event.starts_at, event.ends_at = normalize_all_day_bounds(event.starts_at, event.ends_at, event.timezone)
    if "recurrence" in body.model_fields_set:
        if body.recurrence and body.recurrence.until and body.recurrence.until <= event.starts_at:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="recurrence until must be after starts_at")
        became_one_off = event.recurrence is not None and body.recurrence is None
        event.recurrence = body.recurrence.model_dump(mode="json") if body.recurrence else None
        if became_one_off:
            # An override identifies one occurrence of a series; with the series gone it is an
            # edit no code path can reach or remove.
            await db.execute(delete(CalendarEventOverride).where(CalendarEventOverride.calendar_event_id == event.id))
    if body.participants is not None:
        await _replace_participants(db, event, body.participants, dashboard, shares)
    event.updated_by = current_user.id

    activity = log_event(
        db,
        event_type=EventType.calendar_event_updated,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "recurring": event.recurrence is not None, "dashboard_id": str(dashboard.id)} | _echo_stamp(client_id),
    )
    event_message = await build_activity_sse_dict(db, activity)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(event)
    return _event_response(event, (await _participants_by_event(db, {event.id})).get(event.id, []))


@router.patch("/events/{event_id}/occurrences", response_model=CalendarOccurrenceMutationResponse)
@limiter.limit(WRITE_LIMIT)
async def update_occurrence(
    request: Request,
    event_id: uuid.UUID,
    body: CalendarOccurrenceUpdate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarOccurrenceMutationResponse:
    """Create or update a single recurring-event occurrence override."""
    event, dashboard, shares, role = await _get_event_access(event_id, current_user, db)
    if event.recurrence is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only recurring events support occurrence overrides")
    permissions.assert_can_edit(role)

    result = await db.execute(
        select(CalendarEventOverride).where(
            CalendarEventOverride.calendar_event_id == event.id,
            CalendarEventOverride.occurrence_start == body.occurrence_start.astimezone(UTC),
        )
    )
    override = result.scalar_one_or_none()
    if override is None:
        override = CalendarEventOverride(
            calendar_event_id=event.id,
            created_by=current_user.id,
            updated_by=current_user.id,
            occurrence_start=body.occurrence_start.astimezone(UTC),
        )
        db.add(override)

    override.cancelled = body.cancelled
    override.title = body.title
    override.description = body.description
    override.location = body.location
    override.starts_at = body.starts_at.astimezone(UTC) if body.starts_at is not None else None
    override.ends_at = body.ends_at.astimezone(UTC) if body.ends_at is not None else None
    override.timezone = body.timezone
    override.all_day = body.all_day
    override.updated_by = current_user.id

    activity = log_event(
        db,
        event_type=EventType.calendar_event_occurrence_cancelled if body.cancelled else EventType.calendar_event_occurrence_updated,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "occurrence_start": body.occurrence_start.astimezone(UTC).isoformat(), "dashboard_id": str(dashboard.id)}
        | _echo_stamp(client_id),
    )
    event_message = await build_activity_sse_dict(db, activity)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(override)

    occurrence = expand_event_occurrences(
        event,
        {override.occurrence_start: override},
        body.occurrence_start.astimezone(UTC) - (event.ends_at - event.starts_at),
        (override.ends_at or event.ends_at) + (event.ends_at - event.starts_at),
    )
    if not occurrence:
        return CalendarOccurrenceMutationResponse(cancelled=True, occurrence=None)
    return CalendarOccurrenceMutationResponse(
        cancelled=False,
        occurrence=_occurrence_response(occurrence[0], (await _participants_by_event(db, {event.id})).get(event.id, [])),
    )


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_event(
    request: Request,
    event_id: uuid.UUID,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete a calendar event and notify dashboard subscribers.

    Recoverable through `restore_event` until the reaper purges it; the client surfaces that as an
    undo on the confirmation toast.
    """
    event, dashboard, shares, role = await _get_event_access(event_id, current_user, db)
    permissions.assert_can_edit(role)

    activity = log_event(
        db,
        event_type=EventType.calendar_event_deleted,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "dashboard_id": str(dashboard.id)} | _echo_stamp(client_id),
    )
    event.deleted_at = datetime.now(UTC)
    event.updated_by = current_user.id
    event_message = await build_activity_sse_dict(db, activity)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )


@router.post("/events/{event_id}/restore", response_model=CalendarEventResponse)
@limiter.limit(WRITE_LIMIT)
async def restore_event(
    request: Request,
    event_id: uuid.UUID,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    """Bring a deleted event back until the reaper purges it.

    Restores rather than recreates, so recurrence, per-occurrence overrides and participants return
    with it — the reason an event is tombstoned where a list item is not (ADR-007). Loaded here
    rather than through `_get_event_access`, which cannot see a deleted row.
    """
    result = await db.execute(select(CalendarEvent).where(CalendarEvent.id == event_id, CalendarEvent.deleted_at.is_not(None)))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    dashboard, shares, role = await load_dashboard_access(event.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    event.deleted_at = None
    event.updated_by = current_user.id
    activity = log_event(
        db,
        event_type=EventType.calendar_event_created,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "restored": True, "dashboard_id": str(dashboard.id)} | _echo_stamp(client_id),
    )
    event_message = await build_activity_sse_dict(db, activity)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(event)
    return _event_response(event, (await _participants_by_event(db, {event.id})).get(event.id, []))


@router.delete("/events/{event_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def purge_trashed_event(
    request: Request,
    event_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a trashed event outright, ahead of the reaper.

    One statement, unlike `purge_dashboard`: overrides, participants and reminders all carry
    ON DELETE CASCADE, so the row takes them with it. Needs edit on the live parent dashboard, and
    broadcasts nothing — the event is already invisible outside the trash view.
    """
    result = await db.execute(select(CalendarEvent).where(CalendarEvent.id == event_id, CalendarEvent.deleted_at.is_not(None)))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    _dashboard, _shares, role = await load_dashboard_access(event.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    await db.delete(event)
    await db.commit()


@router.get("/events/{event_id}/shares", response_model=ResourceAccessResponse)
async def list_event_shares(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResourceAccessResponse:
    """Show that event access is inherited from the parent dashboard."""
    _event, dashboard, _shares, _role = await _get_event_access(event_id, current_user, db)
    return _dashboard_managed_permissions_response(dashboard)


@router.post("/events/{event_id}/shares", status_code=status.HTTP_201_CREATED)
@limiter.limit(WRITE_LIMIT)
async def add_event_share(
    request: Request,
    event_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct event sharing because dashboards own permissions."""
    await _get_event_access(event_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.patch("/events/{event_id}/shares/{share_id}")
@limiter.limit(WRITE_LIMIT)
async def update_event_share(
    request: Request,
    event_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct event share updates because dashboards own permissions."""
    await _get_event_access(event_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.delete("/events/{event_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_event_share(
    request: Request,
    event_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct event share deletion because dashboards own permissions."""
    await _get_event_access(event_id, current_user, db)
    _raise_dashboard_managed_permissions_error()
