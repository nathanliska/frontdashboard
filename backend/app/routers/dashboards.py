import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.models.calendar import CalendarEvent, CalendarEventOverride
from app.models.dashboard import Dashboard, DashboardWidget
from app.models.list import List, ListItem, ListType
from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.calendar import CalendarEventCreate, CalendarEventResponse, CalendarOccurrenceResponse
from app.schemas.dashboards import (
    DashboardCreate,
    DashboardResponse,
    DashboardSummary,
    DashboardUpdate,
    LayoutUpdate,
    WidgetConfigUpdate,
    WidgetCreate,
    WidgetResponse,
)
from app.schemas.shares import ShareCreate, ShareResponse, ShareUpdate
from app.services import permissions
from app.services.activity import EventType, log_event
from app.services.calendar import expand_event_occurrences
from app.services.shares import (
    cleanup_resource_shares,
    create_share,
    get_resource_share,
    get_resource_shares,
    insert_shares,
    load_resource_access,
    resolve_share_responses,
)
from app.services.widget_policy import (
    WidgetContentMode,
    get_widget_policy,
)
from app.sse.events import build_activity_sse_dict
from app.sse.manager import manager

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


async def _load_widgets(dashboard_id: uuid.UUID, db: AsyncSession) -> list[DashboardWidget]:
    result = await db.execute(select(DashboardWidget).where(DashboardWidget.dashboard_id == dashboard_id).order_by(DashboardWidget.created_at))
    return list(result.scalars().all())


def _to_summary(
    dashboard: Dashboard,
    access_description: str | None = None,
    is_shared: bool = False,
) -> DashboardSummary:
    return DashboardSummary.model_validate(
        {
            "id": dashboard.id,
            "user_id": dashboard.user_id,
            "name": dashboard.name,
            "access_description": access_description,
            "is_shared": is_shared,
            "is_favorite": dashboard.is_favorite,
            "version": dashboard.version,
            "created_at": dashboard.created_at,
            "updated_at": dashboard.updated_at,
        }
    )


def _to_response(
    dashboard: Dashboard,
    widgets: list[DashboardWidget],
    is_shared: bool,
) -> DashboardResponse:
    layout = dashboard.layout if isinstance(dashboard.layout, list) else []
    return DashboardResponse(
        id=dashboard.id,
        user_id=dashboard.user_id,
        name=dashboard.name,
        is_shared=is_shared,
        is_favorite=dashboard.is_favorite,
        layout=layout,
        version=dashboard.version,
        widgets=[WidgetResponse.model_validate(w) for w in widgets],
    )


def _next_y(layout: list[dict[str, Any]]) -> int:
    if not layout:
        return 0
    return max(item.get("y", 0) + item.get("h", 1) for item in layout)


async def _get_dashboard_access(
    dashboard_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[Dashboard, list[ResourceShare], ShareRole | None]:
    result = await db.execute(select(Dashboard).where(Dashboard.id == dashboard_id))
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    shares, role = await load_resource_access(
        ResourceType.dashboard,
        dashboard.id,
        dashboard.user_id,
        user,
        db,
    )
    return dashboard, shares, role


async def _accessible_dashboard_query(user: User, db: AsyncSession) -> list[Dashboard]:
    shared_ids = select(ResourceShare.resource_id).where(
        ResourceShare.resource_type == ResourceType.dashboard,
        ResourceShare.principal_type == PrincipalType.user,
        ResourceShare.principal_id == user.id,
    )

    result = await db.execute(
        select(Dashboard)
        .where(
            or_(
                Dashboard.user_id == user.id,
                Dashboard.id.in_(shared_ids),
            )
        )
        .order_by(Dashboard.is_favorite.desc(), Dashboard.updated_at.desc())
    )
    return list(result.scalars().all())


async def _dashboard_access_descriptions(
    dashboards: list[Dashboard],
    user: User,
    db: AsyncSession,
) -> dict[uuid.UUID, str]:
    if not dashboards:
        return {}

    dashboard_ids = [dashboard.id for dashboard in dashboards if dashboard.user_id is not None]
    shares_by_dashboard: dict[uuid.UUID, list[ResourceShare]] = {}
    if dashboard_ids:
        shares_result = await db.execute(
            select(ResourceShare).where(
                ResourceShare.resource_type == ResourceType.dashboard,
                ResourceShare.resource_id.in_(dashboard_ids),
            )
        )
        for share in shares_result.scalars().all():
            shares_by_dashboard.setdefault(share.resource_id, []).append(share)

    descriptions: dict[uuid.UUID, str] = {}
    for dashboard in dashboards:
        if dashboard.user_id == user.id:
            descriptions[dashboard.id] = "Owned by you"
            continue

        shares = shares_by_dashboard.get(dashboard.id, [])
        if any(share.principal_type == PrincipalType.user and share.principal_id == user.id for share in shares):
            descriptions[dashboard.id] = "Shared directly with you"
            continue

        descriptions[dashboard.id] = "Shared with you"

    return descriptions


def _dashboard_is_shared(dashboard: Dashboard, shares: list[ResourceShare]) -> bool:
    return bool(shares)


async def _dashboard_audience_user_ids(
    dashboard: Dashboard,
    shares: list[ResourceShare],
    db: AsyncSession,
) -> set[uuid.UUID]:
    audience_user_ids: set[uuid.UUID] = {dashboard.user_id}
    audience_user_ids.update({share.principal_id for share in shares if share.principal_type == PrincipalType.user})
    return audience_user_ids


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
        recurrence=event.recurrence,
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


@router.get("", response_model=list[DashboardSummary])
async def list_dashboards(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DashboardSummary]:
    dashboards = await _accessible_dashboard_query(current_user, db)
    descriptions = await _dashboard_access_descriptions(dashboards, current_user, db)
    dashboard_ids = [dashboard.id for dashboard in dashboards if dashboard.user_id is not None]
    shared_ids: set[uuid.UUID] = set()
    if dashboard_ids:
        share_result = await db.execute(
            select(ResourceShare.resource_id).where(
                ResourceShare.resource_type == ResourceType.dashboard,
                ResourceShare.resource_id.in_(dashboard_ids),
            )
        )
        shared_ids = {row[0] for row in share_result.all()}

    return [
        _to_summary(
            dashboard,
            descriptions.get(dashboard.id),
            dashboard.id in shared_ids,
        )
        for dashboard in dashboards
    ]


@router.post("", status_code=status.HTTP_201_CREATED, response_model=DashboardSummary)
async def create_dashboard(
    body: DashboardCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    dashboard = Dashboard(user_id=current_user.id, name=body.name)
    db.add(dashboard)
    await db.flush()
    await insert_shares(ResourceType.dashboard, dashboard.id, body.shares, current_user.id, db)
    await db.commit()
    await db.refresh(dashboard)
    return _to_summary(dashboard, "Owned by you", bool(body.shares))


@router.patch("/{dashboard_id}", response_model=DashboardSummary)
async def update_dashboard_meta(
    dashboard_id: uuid.UUID,
    body: DashboardUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    if body.name is not None:
        permissions.assert_can_edit(role)
        dashboard.name = body.name
    if body.is_favorite is not None:
        dashboard.is_favorite = body.is_favorite
    await db.commit()
    await db.refresh(dashboard)
    descriptions = await _dashboard_access_descriptions([dashboard], current_user, db)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    return _to_summary(
        dashboard,
        descriptions.get(dashboard.id),
        _dashboard_is_shared(dashboard, current_shares),
    )


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_delete(role)

    list_result = await db.execute(select(List.id).where(List.dashboard_id == dashboard.id))
    list_ids = [row[0] for row in list_result.all()]
    for list_id in list_ids:
        await cleanup_resource_shares(ResourceType.list, list_id, db)
    if list_ids:
        await db.execute(delete(ListItem).where(ListItem.list_id.in_(list_ids)))
        await db.execute(delete(List).where(List.id.in_(list_ids)))

    event_result = await db.execute(select(CalendarEvent.id).where(CalendarEvent.dashboard_id == dashboard.id))
    event_ids = [row[0] for row in event_result.all()]
    for event_id in event_ids:
        await cleanup_resource_shares(ResourceType.calendar_event, event_id, db)
    if event_ids:
        await db.execute(delete(CalendarEvent).where(CalendarEvent.id.in_(event_ids)))

    await db.execute(delete(DashboardWidget).where(DashboardWidget.dashboard_id == dashboard.id))
    await cleanup_resource_shares(ResourceType.dashboard, dashboard.id, db)
    await db.execute(delete(Dashboard).where(Dashboard.id == dashboard.id))
    await db.commit()


@router.get("/default", response_model=DashboardResponse)
async def get_default_dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    result = await db.execute(
        select(Dashboard).where(Dashboard.user_id == current_user.id).order_by(Dashboard.is_favorite.desc(), Dashboard.created_at.asc()).limit(1)
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    widgets = await _load_widgets(dashboard.id, db)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    return _to_response(dashboard, widgets, _dashboard_is_shared(dashboard, current_shares))


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    dashboard, shares, _role = await _get_dashboard_access(dashboard_id, current_user, db)
    widgets = await _load_widgets(dashboard.id, db)
    return _to_response(dashboard, widgets, _dashboard_is_shared(dashboard, shares))


@router.put("/{dashboard_id}/layout", response_model=DashboardResponse)
async def update_layout(
    dashboard_id: uuid.UUID,
    body: LayoutUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_edit(role)
    if dashboard.version != body.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Version conflict: expected {dashboard.version}, got {body.version}",
        )
    dashboard.layout = body.layout
    dashboard.version += 1
    await db.commit()
    await db.refresh(dashboard)
    widgets = await _load_widgets(dashboard.id, db)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    return _to_response(dashboard, widgets, _dashboard_is_shared(dashboard, current_shares))


@router.post("/{dashboard_id}/widgets", status_code=status.HTTP_201_CREATED, response_model=DashboardResponse)
async def add_widget(
    dashboard_id: uuid.UUID,
    body: WidgetCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    dashboard, shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_edit(role)
    is_shared_dashboard = _dashboard_is_shared(dashboard, shares)
    widget_policy = get_widget_policy(body.widget_type)
    widget_config = dict(body.config)
    resource_type = body.resource_type
    resource_id = body.resource_id

    if widget_policy.content_mode == WidgetContentMode.resource:
        expected_resource_type = widget_policy.resource_type.value if widget_policy.resource_type else None
        if widget_policy.resource_type != ResourceType.list:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Unsupported widget resource type: {body.widget_type}",
            )

        resource_type = expected_resource_type
        if resource_id is None:
            list_name = str(widget_config.get("name") or "").strip() or "Untitled List"
            raw_list_type = str(widget_config.get("list_type") or "checklist")
            try:
                list_type = ListType(raw_list_type)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="Invalid list type",
                ) from exc

            created_list = List(
                dashboard_id=dashboard.id,
                created_by=current_user.id,
                updated_by=current_user.id,
                name=list_name,
                list_type=list_type,
            )
            db.add(created_list)
            await db.flush()
            resource_id = created_list.id
            widget_config = {
                **widget_config,
                "list_name": list_name,
                "list_type": list_type.value,
            }
            widget_config.pop("name", None)
        else:
            list_result = await db.execute(
                select(List).where(
                    List.id == resource_id,
                    List.dashboard_id == dashboard.id,
                    List.deleted_at.is_(None),
                )
            )
            existing_list = list_result.scalar_one_or_none()
            if existing_list is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="List not found on this dashboard",
                )
    elif body.resource_type is not None or body.resource_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"{body.widget_type.title()} widgets cannot bind to a resource",
        )

    if widget_policy.content_mode == WidgetContentMode.resource and resource_type and resource_id:
        existing_widget_result = await db.execute(
            select(DashboardWidget).where(
                DashboardWidget.dashboard_id == dashboard.id,
                DashboardWidget.resource_type == resource_type,
                DashboardWidget.resource_id == resource_id,
            )
        )
        if existing_widget_result.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="That item is already on this dashboard",
            )

    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        widget_type=body.widget_type,
        config=widget_config,
        resource_type=resource_type,
        resource_id=resource_id,
    )
    db.add(widget)
    await db.flush()

    current_layout: list[dict[str, Any]] = dashboard.layout if isinstance(dashboard.layout, list) else []
    dashboard.layout = current_layout + [
        {
            "i": str(widget.id),
            "x": 0,
            "y": _next_y(current_layout),
            "w": 4,
            "h": 4,
        }
    ]
    dashboard.version += 1
    await db.commit()
    await db.refresh(dashboard)
    widgets = await _load_widgets(dashboard.id, db)
    return _to_response(dashboard, widgets, is_shared_dashboard)


@router.post(
    "/{dashboard_id}/calendar-events",
    status_code=status.HTTP_201_CREATED,
    response_model=CalendarEventResponse,
)
async def create_dashboard_calendar_event(
    dashboard_id: uuid.UUID,
    body: CalendarEventCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CalendarEventResponse:
    dashboard, shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_edit(role)
    if body.dashboard_id != dashboard.id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="dashboard_id must match the dashboard in the URL",
        )

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
        group_id=None,
        payload={"title": event.title, "recurring": event.recurrence is not None, "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, activity)
    await db.commit()
    await db.refresh(event)
    await manager.broadcast(
        event_message,
        group_id=None,
        user_ids=await _dashboard_audience_user_ids(dashboard, shares, db),
        actor_id=current_user.id,
    )
    return _event_response(event)


@router.get(
    "/{dashboard_id}/calendar-occurrences",
    response_model=list[CalendarOccurrenceResponse],
)
async def list_dashboard_calendar_occurrences(
    dashboard_id: uuid.UUID,
    window_start: datetime,
    window_end: datetime,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CalendarOccurrenceResponse]:
    if window_start.tzinfo is None or window_start.utcoffset() is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="window_start must be timezone-aware",
        )
    if window_end.tzinfo is None or window_end.utcoffset() is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="window_end must be timezone-aware",
        )
    if window_end <= window_start:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="window_end must be after window_start",
        )

    dashboard, _shares, _role = await _get_dashboard_access(dashboard_id, current_user, db)
    event_result = await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.dashboard_id == dashboard.id,
        )
    )
    events = list(event_result.scalars().all())
    if not events:
        return []

    overrides_result = await db.execute(
        select(CalendarEventOverride).where(CalendarEventOverride.calendar_event_id.in_([event.id for event in events]))
    )
    overrides = list(overrides_result.scalars().all())
    overrides_by_event: dict[uuid.UUID, dict[datetime, CalendarEventOverride]] = {event.id: {} for event in events}
    for override in overrides:
        overrides_by_event.setdefault(override.calendar_event_id, {})[override.occurrence_start] = override

    window_start = window_start.astimezone(UTC)
    window_end = window_end.astimezone(UTC)
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


@router.patch("/{dashboard_id}/widgets/{widget_id}", response_model=WidgetResponse)
async def update_widget(
    dashboard_id: uuid.UUID,
    widget_id: uuid.UUID,
    body: WidgetConfigUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WidgetResponse:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_edit(role)
    result = await db.execute(
        select(DashboardWidget).where(
            DashboardWidget.id == widget_id,
            DashboardWidget.dashboard_id == dashboard.id,
        )
    )
    widget = result.scalar_one_or_none()
    if widget is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Widget not found")
    widget.config = body.config
    await db.commit()
    await db.refresh(widget)
    return WidgetResponse.model_validate(widget)


@router.delete("/{dashboard_id}/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    dashboard_id: uuid.UUID,
    widget_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_edit(role)
    result = await db.execute(
        select(DashboardWidget).where(
            DashboardWidget.id == widget_id,
            DashboardWidget.dashboard_id == dashboard.id,
        )
    )
    widget = result.scalar_one_or_none()
    if widget is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Widget not found")

    await db.delete(widget)
    current_layout: list[dict[str, Any]] = dashboard.layout if isinstance(dashboard.layout, list) else []
    dashboard.layout = [item for item in current_layout if item.get("i") != str(widget_id)]
    dashboard.version += 1
    await db.commit()


@router.get("/{dashboard_id}/shares", response_model=list[ShareResponse])
async def list_dashboard_shares(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ShareResponse]:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    shares = await get_resource_shares(ResourceType.dashboard, dashboard_id, db)
    return await resolve_share_responses(shares, db)


@router.post("/{dashboard_id}/shares", status_code=status.HTTP_201_CREATED, response_model=ShareResponse)
async def add_dashboard_share(
    dashboard_id: uuid.UUID,
    body: ShareCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ShareResponse:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await create_share(ResourceType.dashboard, dashboard_id, body, current_user.id, db)
    await db.commit()
    return (await resolve_share_responses([share], db))[0]


@router.patch("/{dashboard_id}/shares/{share_id}", response_model=ShareResponse)
async def update_dashboard_share(
    dashboard_id: uuid.UUID,
    share_id: uuid.UUID,
    body: ShareUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ShareResponse:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await get_resource_share(ResourceType.dashboard, dashboard_id, share_id, db)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    share.role = body.role
    await db.commit()
    await db.refresh(share)
    return (await resolve_share_responses([share], db))[0]


@router.delete("/{dashboard_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard_share(
    dashboard_id: uuid.UUID,
    share_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    dashboard, _shares, role = await _get_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await get_resource_share(ResourceType.dashboard, dashboard_id, share_id, db)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    await db.delete(share)
    await db.commit()
