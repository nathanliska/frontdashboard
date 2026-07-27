import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.models.calendar import CalendarEvent, CalendarEventOverride
from app.models.dashboard import Dashboard
from app.models.share import ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.calendar import (
    CalendarEventCreate,
    CalendarEventResponse,
    CalendarEventUpdate,
    CalendarOccurrenceMutationResponse,
    CalendarOccurrenceResponse,
    CalendarOccurrenceUpdate,
    RecurrenceRule,
)
from app.schemas.shares import InheritedDashboardAccessResponse, ResourceAccessResponse
from app.services import permissions
from app.services.activity import EventType, log_event
from app.services.calendar import expand_event_occurrences
from app.services.shares import (
    cleanup_resource_shares,
    list_accessible_dashboard_ids,
    load_dashboard_access,
)
from app.sse.events import build_activity_sse_dict
from app.sse.manager import manager

router = APIRouter(prefix="/calendar", tags=["calendar"])


def _dashboard_user_ids(
    dashboard: Dashboard,
    shares: list[ResourceShare],
) -> set[uuid.UUID]:
    user_ids: set[uuid.UUID] = {dashboard.user_id}
    user_ids.update(share.principal_id for share in shares)
    return user_ids


async def _broadcast_dashboard_event(
    message: dict,
    dashboard: Dashboard,
    shares: list[ResourceShare],
    actor_id: uuid.UUID,
) -> None:
    await manager.broadcast(
        message,
        user_ids=_dashboard_user_ids(dashboard, shares),
        actor_id=actor_id,
    )


async def _get_event_access(
    event_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[CalendarEvent, Dashboard, list[ResourceShare], ShareRole | None]:
    result = await db.execute(select(CalendarEvent).where(CalendarEvent.id == event_id, CalendarEvent.deleted_at.is_(None)))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    dashboard, shares, role = await load_dashboard_access(event.dashboard_id, user, db)
    return event, dashboard, shares, role


def _event_response(event: CalendarEvent) -> CalendarEventResponse:
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
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def _occurrence_response(occurrence) -> CalendarOccurrenceResponse:
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
async def create_event(
    body: CalendarEventCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    """Create a calendar event on an accessible dashboard."""
    dashboard, shares, role = await load_dashboard_access(body.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    event = CalendarEvent(
        dashboard_id=dashboard.id,
        created_by=current_user.id,
        updated_by=current_user.id,
        title=body.title,
        description=body.description,
        location=body.location,
        starts_at=body.starts_at.astimezone(UTC),
        ends_at=body.ends_at.astimezone(UTC),
        timezone=body.timezone,
        all_day=body.all_day,
        recurrence=body.recurrence.model_dump(mode="json") if body.recurrence else None,
    )
    db.add(event)
    await db.flush()

    activity = log_event(
        db,
        event_type=EventType.calendar_event_created,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "recurring": event.recurrence is not None, "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, activity)
    await db.commit()
    await db.refresh(event)
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
    return _event_response(event)


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

    # Only load what could possibly land in the window (#16). This used to fetch every event on
    # every accessible dashboard and discard the misses after expanding them in Python, so the
    # cost of viewing next week grew with the calendar's whole history.
    #
    # A one-off event is bounded by its own times, so the overlap test is the same one
    # `_overlaps` applies after expansion. A recurring one is not: bounding it in SQL needs its
    # last occurrence persisted, which the rule (count/until/interval) does not give us — those
    # still load and are bounded by the expander's skip-ahead instead.
    has_override = select(CalendarEventOverride.id).where(CalendarEventOverride.calendar_event_id == CalendarEvent.id).exists()
    result = await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.dashboard_id.in_(dashboard_ids),
            or_(
                CalendarEvent.recurrence.is_not(None),
                (CalendarEvent.starts_at < window_end) & (CalendarEvent.ends_at > window_start),
                # An override can move an occurrence outside its event's own times. Only
                # recurring events can be overridden today, but an event that *was* recurring
                # can still own override rows written before it was made one-off, and dropping
                # it here would silently hide it. Cheap insurance: such rows are rare, and
                # update_event now deletes them when recurrence is cleared.
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
    return [_occurrence_response(occurrence) for occurrence in occurrences]


@router.get("/events/{event_id}", response_model=CalendarEventResponse)
async def get_event(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    """Return a single calendar event the caller can access."""
    event, _dashboard, _shares, _role = await _get_event_access(event_id, current_user, db)
    return _event_response(event)


@router.patch("/events/{event_id}", response_model=CalendarEventResponse)
async def update_event(
    event_id: uuid.UUID,
    body: CalendarEventUpdate,
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
    if "recurrence" in body.model_fields_set:
        if body.recurrence and body.recurrence.until and body.recurrence.until <= event.starts_at:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="recurrence until must be after starts_at")
        became_one_off = event.recurrence is not None and body.recurrence is None
        event.recurrence = body.recurrence.model_dump(mode="json") if body.recurrence else None
        if became_one_off:
            # An override identifies one occurrence of a series. With the series gone they
            # describe nothing, and leaving them stranded means a one-off event carrying
            # per-occurrence edits that no code path can reach or remove.
            await db.execute(delete(CalendarEventOverride).where(CalendarEventOverride.calendar_event_id == event.id))
    event.updated_by = current_user.id

    activity = log_event(
        db,
        event_type=EventType.calendar_event_updated,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "recurring": event.recurrence is not None, "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, activity)
    await db.commit()
    await db.refresh(event)
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
    return _event_response(event)


@router.patch("/events/{event_id}/occurrences", response_model=CalendarOccurrenceMutationResponse)
async def update_occurrence(
    event_id: uuid.UUID,
    body: CalendarOccurrenceUpdate,
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
        payload={"title": event.title, "occurrence_start": body.occurrence_start.astimezone(UTC).isoformat(), "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, activity)
    await db.commit()
    await db.refresh(override)
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)

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
        occurrence=_occurrence_response(occurrence[0]),
    )


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_event(
    event_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete a calendar event and notify dashboard subscribers."""
    event, dashboard, shares, role = await _get_event_access(event_id, current_user, db)
    permissions.assert_can_edit(role)

    activity = log_event(
        db,
        event_type=EventType.calendar_event_deleted,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="calendar_event",
        entity_id=event.id,
        payload={"title": event.title, "dashboard_id": str(dashboard.id)},
    )
    event.deleted_at = datetime.now(UTC)
    event.updated_by = current_user.id
    event_message = await build_activity_sse_dict(db, activity)
    await cleanup_resource_shares(ResourceType.calendar_event, event.id, db)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)


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
async def add_event_share(
    event_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct event sharing because dashboards own permissions."""
    await _get_event_access(event_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.patch("/events/{event_id}/shares/{share_id}")
async def update_event_share(
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
async def delete_event_share(
    event_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct event share deletion because dashboards own permissions."""
    await _get_event_access(event_id, current_user, db)
    _raise_dashboard_managed_permissions_error()
