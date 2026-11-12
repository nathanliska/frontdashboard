import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.config import settings
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
from app.models.activity import ChangedField
from app.models.dashboard import Dashboard, DashboardWidget
from app.models.share import ResourceType
from app.models.user import User
from app.schemas.dashboards import (
    DashboardCreate,
    DashboardCreatedResponse,
    DashboardResponse,
    DashboardSummary,
    DashboardUpdate,
    LayoutUpdate,
    TrashedDashboardSummary,
    minimum_widget_size,
)
from app.services import permissions
from app.services.activity import EventType
from app.services.dashboards import (
    build_dashboard_event_message,
    list_accessible_dashboard_summaries,
    load_widgets,
    remove_dashboard_from_user_preferences,
    to_response,
    to_summary,
)
from app.services.notifications import build_notification_messages, notification_fanouts
from app.services.preferences import (
    favorite_dashboard_ids_from_preferences,
)
from app.services.quota import assert_under_quota, limit_message
from app.services.retention import purge_dashboard
from app.services.shares import (
    collect_dashboard_access_notifications,
    dashboard_fanout,
    get_resource_shares,
    load_dashboard_access,
)
from app.sse.choreography import ClientIdHeader, commit_and_broadcast

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


@router.get("", response_model=list[DashboardSummary])
async def list_dashboards(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DashboardSummary]:
    """List dashboards the current user owns or can access."""
    return await list_accessible_dashboard_summaries(current_user, db)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=DashboardCreatedResponse)
@limiter.limit(WRITE_LIMIT)
async def create_dashboard(
    request: Request,
    body: DashboardCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardCreatedResponse:
    """Create a dashboard, owned by the caller."""
    await assert_under_quota(
        db,
        model=Dashboard,
        resource="dashboards",
        cap=settings.quota_dashboards_per_user,
        scope=Dashboard.user_id == current_user.id,
        detail=limit_message("dashboards", settings.quota_dashboards_per_user, reclaim="purge"),
    )
    dashboard = Dashboard(user_id=current_user.id, name=body.name)
    db.add(dashboard)
    await db.flush()
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_created,
        current_user=current_user,
        dashboard=dashboard,
        payload={"name": dashboard.name},
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, [])],
    )
    await db.refresh(dashboard)
    summary = to_summary(
        dashboard,
        "Owned by you",
        False,
        can_edit=True,
        can_manage_shares=True,
    )
    return DashboardCreatedResponse(**dict(summary), layout=dashboard.layout or [], widgets=[])


@router.patch("/{dashboard_id}", response_model=DashboardSummary)
@limiter.limit(WRITE_LIMIT)
async def update_dashboard_meta(
    request: Request,
    dashboard_id: uuid.UUID,
    body: DashboardUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    """Update dashboard metadata (currently just the name)."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    if body.name is not None:
        permissions.assert_can_edit(role)
        dashboard.name = body.name
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "name": dashboard.name,
            # Every patchable field is a vocabulary member; test_changed_fields_coverage.py
            # fails the build if one is ever added that isn't.
            "changed_fields": sorted(ChangedField(field) for field in body.model_fields_set),
        },
        client_id=client_id,
    )
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
    await db.refresh(dashboard)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    access_description = "Owned by you" if dashboard.user_id == current_user.id else "Shared directly with you"
    return to_summary(
        dashboard,
        access_description,
        bool(current_shares),
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_dashboard(
    request: Request,
    dashboard_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Move a dashboard to the trash.

    Stamps `deleted_at`, which hides it and its children from every access path until the reaper
    purges it past `trash_retention_days`. Shares survive so a restore comes back as shared;
    favorites and home are dropped on the way in.
    """
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_delete(role)
    dashboard.deleted_at = datetime.now(UTC)
    await remove_dashboard_from_user_preferences(dashboard, shares, db)
    notification_messages = await build_notification_messages(
        db,
        collect_dashboard_access_notifications(
            db,
            dashboard=dashboard,
            shares=shares,
            current_user=current_user,
            event_type=EventType.dashboard_deleted,
            title="Dashboard deleted",
            body=f'{current_user.display_name} deleted "{dashboard.name}". It is no longer available to you.',
        ),
    )
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_deleted,
        current_user=current_user,
        dashboard=dashboard,
        payload={"name": dashboard.name},
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, shares), *notification_fanouts(notification_messages)],
    )


# Declared before GET /{dashboard_id} so the static segment wins (same pattern as /default).
@router.get("/trash", response_model=list[TrashedDashboardSummary])
async def list_trash(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TrashedDashboardSummary]:
    """The caller's own trashed dashboards, newest first, with their purge deadline."""
    result = await db.execute(
        select(Dashboard).where(Dashboard.user_id == current_user.id, Dashboard.deleted_at.is_not(None)).order_by(Dashboard.deleted_at.desc())
    )
    retention = timedelta(days=settings.trash_retention_days)
    summaries: list[TrashedDashboardSummary] = []
    for dashboard in result.scalars().all():
        # The WHERE guarantees deleted_at; the assert narrows the Optional for the type checker.
        assert dashboard.deleted_at is not None
        summaries.append(
            TrashedDashboardSummary(
                id=dashboard.id,
                name=dashboard.name,
                deleted_at=dashboard.deleted_at,
                purge_at=dashboard.deleted_at + retention,
            )
        )
    return summaries


@router.post("/{dashboard_id}/restore", response_model=DashboardSummary)
@limiter.limit(WRITE_LIMIT)
async def restore_dashboard(
    request: Request,
    dashboard_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    """Bring a trashed dashboard back, shares and children intact.

    Loads by ownership, not through the access door — which deliberately cannot see trashed rows.
    """
    result = await db.execute(
        select(Dashboard).where(
            Dashboard.id == dashboard_id,
            Dashboard.user_id == current_user.id,
            Dashboard.deleted_at.is_not(None),
        )
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    dashboard.deleted_at = None
    shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={"changed_fields": [ChangedField.restored]},
        client_id=client_id,
    )
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
    await db.refresh(dashboard)
    return to_summary(
        dashboard,
        "Owned by you",
        bool(shares),
        can_edit=True,
        can_manage_shares=True,
        is_favorite=False,
    )


@router.delete("/{dashboard_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def purge_trashed_dashboard(
    request: Request,
    dashboard_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a trashed dashboard and everything under it, ahead of the reaper.

    Owner-only and trashed-only, loaded like restore does because the access door cannot see
    trashed rows. Broadcasts nothing: the row is already invisible everywhere but this owner's
    trash view, so no other tab holds state this could stale.
    """
    result = await db.execute(
        select(Dashboard).where(
            Dashboard.id == dashboard_id,
            Dashboard.user_id == current_user.id,
            Dashboard.deleted_at.is_not(None),
        )
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    await purge_dashboard(db, dashboard)
    await db.commit()


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    """Return a dashboard with its widgets and access metadata."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    widgets = await load_widgets(dashboard.id, db)
    return to_response(
        dashboard,
        widgets,
        bool(shares),
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )


@router.put("/{dashboard_id}/layout", response_model=DashboardResponse)
@limiter.limit(WRITE_LIMIT)
async def update_layout(
    request: Request,
    dashboard_id: uuid.UUID,
    body: LayoutUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    """Replace dashboard layout coordinates with optimistic version checks."""
    # Serialize layout/version mutations so optimistic conflict checks stay race-safe.
    dashboard, shares, role = await load_dashboard_access(
        dashboard_id,
        current_user,
        db,
        lock_for_update=True,
    )
    permissions.assert_can_edit(role)
    if dashboard.version != body.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Version conflict: expected {dashboard.version}, got {body.version}",
        )
    widgets = await load_widgets(dashboard.id, db)
    widget_types = {str(widget.id): widget.widget_type for widget in widgets}
    saved = {item["i"]: item for item in dashboard.layout or []}
    for item in body.layout:
        min_w, min_h = minimum_widget_size(widget_types.get(item.i, ""))
        previous = saved.get(item.i)
        if previous:
            min_w = min(min_w, previous.get("w", min_w))
            min_h = min(min_h, previous.get("h", min_h))
        if item.w < min_w or item.h < min_h:
            raise HTTPException(status_code=422, detail=f"Widget must be at least {min_w} columns by {min_h} rows")
    # Dump to plain dicts for the JSON column; model_dump also drops the transient
    # react-grid-layout bookkeeping keys the client round-trips (see LayoutItem).
    dashboard.layout = [item.model_dump() for item in body.layout]
    dashboard.version += 1
    payload: dict[str, Any] = {
        "version": dashboard.version,
        "changed_fields": [ChangedField.layout],
    }
    if body.gesture is not None:
        # Rendered back to its own author, but still client-supplied: a widget id from another
        # dashboard would put a stranger's widget type in this feed, so it is looked up here.
        gestured = await db.scalar(
            select(DashboardWidget).where(
                DashboardWidget.id == body.gesture.widget_id,
                DashboardWidget.dashboard_id == dashboard.id,
            )
        )
        if gestured is not None:
            payload["widget_id"] = str(gestured.id)
            payload["widget_type"] = gestured.widget_type
            payload["layout_action"] = body.gesture.action
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload=payload,
        client_id=client_id,
    )
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
    await db.refresh(dashboard)
    widgets = await load_widgets(dashboard.id, db)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    return to_response(
        dashboard,
        widgets,
        bool(current_shares),
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )
