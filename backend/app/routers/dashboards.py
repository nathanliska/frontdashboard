import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.config import settings
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
from app.models.activity import ChangedField
from app.models.dashboard import Dashboard, DashboardWidget
from app.models.list import List
from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.dashboards import (
    WIDGET_CONFIG_MODELS,
    DashboardCreate,
    DashboardCreatedResponse,
    DashboardResponse,
    DashboardSummary,
    DashboardUpdate,
    LayoutUpdate,
    ListWidgetCreate,
    TrashedDashboardSummary,
    WidgetAddedResponse,
    WidgetConfigUpdate,
    WidgetCreate,
    WidgetResponse,
    WidgetResponseAdapter,
    minimum_widget_size,
)
from app.schemas.lists import ListResponse
from app.schemas.shares import DashboardMemberResponse, OwnerTransfer, ShareCreate, ShareResponse, ShareUpdate
from app.services import permissions
from app.services.accounts import lock_live_user
from app.services.activity import EventType
from app.services.dashboard_widgets import bind_list_widget, default_widget_size, fit_widget
from app.services.dashboards import (
    build_dashboard_event_message,
    list_accessible_dashboard_summaries,
    load_widgets,
    remove_dashboard_from_user_preferences,
    to_response,
    to_summary,
)
from app.services.notifications import build_notification_messages, notification_fanouts, stage_notification
from app.services.preferences import (
    favorite_dashboard_ids_from_preferences,
    remove_dashboard_from_preferences,
)
from app.services.quota import assert_under_quota, limit_message
from app.services.retention import purge_dashboard
from app.services.shares import (
    collect_dashboard_access_notifications,
    create_share,
    dashboard_fanout,
    get_resource_share,
    get_resource_shares,
    load_dashboard_access,
    resolve_member_responses,
    resolve_share_responses,
    stage_dashboard_share_notification,
)
from app.sse.choreography import ClientIdHeader, commit_and_broadcast

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


def _dashboard_share_event_payload(
    dashboard: Dashboard,
    share: ResourceShare,
    action: str,
) -> dict[str, Any]:
    return {
        "dashboard_name": dashboard.name,
        "changed_fields": [ChangedField.shares],
        "share_action": action,
        "share_event_type": f"dashboard.share_{action}",
        "share_id": str(share.id),
        "principal_type": str(share.principal_type),
        "principal_id": str(share.principal_id),
        "role": str(share.role),
    }


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


@router.post("/{dashboard_id}/widgets", status_code=status.HTTP_201_CREATED, response_model=WidgetAddedResponse)
@limiter.limit(WRITE_LIMIT)
async def add_widget(
    request: Request,
    dashboard_id: uuid.UUID,
    body: WidgetCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> WidgetAddedResponse:
    """Add a widget to a dashboard, creating bound resources when needed."""
    # Lock the dashboard row so concurrent widget/layout mutations can't lose version/layout updates.
    dashboard, shares, role = await load_dashboard_access(
        dashboard_id,
        current_user,
        db,
        lock_for_update=True,
    )
    permissions.assert_can_edit(role)
    await assert_under_quota(
        db,
        model=DashboardWidget,
        resource="widgets",
        cap=settings.quota_widgets_per_dashboard,
        scope=DashboardWidget.dashboard_id == dashboard.id,
        detail=limit_message("widgets on this dashboard", settings.quota_widgets_per_dashboard, reclaim="immediate"),
    )
    is_shared_dashboard = bool(shares)
    # exclude_unset so omitted fields stay absent rather than landing as explicit nulls; extras
    # survive because every config model is extra="allow".
    widget_config = body.config.model_dump(exclude_unset=True)
    resource_type: str | None = None
    resource_id: uuid.UUID | None = None
    created_list: List | None = None

    # A schema fact: only ListWidgetCreate carries resource fields, and they are a 422 on any
    # other variant (extra="forbid").
    if isinstance(body, ListWidgetCreate):
        resource_type = ResourceType.list.value
        resource_id, created_list, widget_config = await bind_list_widget(
            db,
            dashboard=dashboard,
            current_user=current_user,
            resource_id=body.resource_id,
            widget_config=widget_config,
        )

    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        widget_type=body.widget_type,
        config=widget_config,
        resource_type=resource_type,
        resource_id=resource_id,
    )
    db.add(widget)
    try:
        await db.flush()
    except IntegrityError as exc:
        # Closes the pre-check's race window: two concurrent adds both pass it, and the loser
        # lands here. Same outcome, same message.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That item is already on this dashboard",
        ) from exc

    current_layout: list[dict[str, Any]] = dashboard.layout if isinstance(dashboard.layout, list) else []
    default_w, default_h = default_widget_size(body.widget_type)
    minimum = minimum_widget_size(body.widget_type)
    placement = fit_widget(current_layout, default_w, default_h, minimum=minimum)
    if placement is None:
        # A leftover sliver cannot hold usable content. Roll back the widget and any auto-created
        # resource together, so a failed placement leaves nothing behind.
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"No free space of at least {minimum[0]}×{minimum[1]} cells for this widget — make room by moving or removing one first",
        )
    slot_x, slot_y, slot_w, slot_h = placement
    dashboard.layout = current_layout + [
        {
            "i": str(widget.id),
            "x": slot_x,
            "y": slot_y,
            "w": slot_w,
            "h": slot_h,
        }
    ]
    dashboard.version += 1
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "widget_id": str(widget.id),
            "widget_type": widget.widget_type,
            "resource_type": widget.resource_type,
            "resource_id": str(widget.resource_id) if widget.resource_id else None,
            # Add and remove are the same event type with the same changed_fields, so the feed
            # cannot tell them apart without this.
            "widget_action": "added",
            "changed_fields": [ChangedField.widgets, ChangedField.layout],
        },
        client_id=client_id,
    )
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
    await db.refresh(dashboard)
    widgets = await load_widgets(dashboard.id, db)
    response = to_response(
        dashboard,
        widgets,
        is_shared_dashboard,
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )
    list_response = None
    if created_list is not None:
        await db.refresh(created_list)
        list_response = ListResponse(
            id=created_list.id,
            dashboard_id=created_list.dashboard_id,
            name=created_list.name,
            list_type=created_list.list_type,
            sort_order=created_list.sort_order,
            created_by=created_list.created_by,
            created_at=created_list.created_at,
            updated_at=created_list.updated_at,
            item_count=0,
        )
    return WidgetAddedResponse(**dict(response), created_list=list_response)


@router.patch("/{dashboard_id}/widgets/{widget_id}", response_model=WidgetResponse)
@limiter.limit(WRITE_LIMIT)
async def update_widget(
    request: Request,
    dashboard_id: uuid.UUID,
    widget_id: uuid.UUID,
    body: WidgetConfigUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> WidgetResponse:
    """Update widget configuration on a dashboard."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
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
    # The body can't discriminate itself — the type is on the row. Unvalidated, a stored
    # `{"timezone": 123}` would 500 every later read of the dashboard.
    config_model = WIDGET_CONFIG_MODELS.get(widget.widget_type)
    if config_model is None:
        # A row this code no longer understands; reads of it already fail. Don't 500 the write too.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown widget type: {widget.widget_type}",
        )
    try:
        validated_config = config_model.model_validate(body.config)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Invalid {widget.widget_type} widget config",
        ) from exc
    # exclude_unset: store exactly the keys the caller sent (extras included — the client spreads
    # {...config} back on update, so dropping them would silently lose data).
    widget.config = validated_config.model_dump(exclude_unset=True)
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "widget_id": str(widget.id),
            "widget_type": widget.widget_type,
            # Lets other tabs patch the widget instead of reloading the dashboard. Safe only
            # because a config write bumps no version — layout writes, which do, are excluded.
            "config": widget.config,
            "changed_fields": [ChangedField.widgets],
        },
        client_id=client_id,
    )
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
    await db.refresh(widget)
    return WidgetResponseAdapter.validate_python(widget)


@router.delete("/{dashboard_id}/widgets/{widget_id}", response_model=DashboardResponse)
@limiter.limit(WRITE_LIMIT)
async def delete_widget(
    request: Request,
    dashboard_id: uuid.UUID,
    widget_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    """Delete a widget and remove its layout entry from the dashboard."""
    # Lock the dashboard row so concurrent widget/layout mutations can't lose version/layout updates.
    dashboard, shares, role = await load_dashboard_access(
        dashboard_id,
        current_user,
        db,
        lock_for_update=True,
    )
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
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "widget_id": str(widget.id),
            "widget_type": widget.widget_type,
            "widget_action": "removed",
            "changed_fields": [ChangedField.widgets, ChangedField.layout],
        },
        client_id=client_id,
    )
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
    await db.refresh(dashboard)
    widgets = await load_widgets(dashboard.id, db)
    return to_response(
        dashboard,
        widgets,
        bool(shares),
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )


@router.get("/{dashboard_id}/members", response_model=list[DashboardMemberResponse])
async def list_dashboard_members(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DashboardMemberResponse]:
    """Everyone with access to this dashboard, owner first.

    Readable by any member, unlike `/shares`: the picker attaching people to events is an editor
    surface, and display names are already mutually visible in the activity feed.
    """
    dashboard, shares, _role = await load_dashboard_access(dashboard_id, current_user, db)
    return await resolve_member_responses(dashboard, shares, db)


@router.get("/{dashboard_id}/shares", response_model=list[ShareResponse])
async def list_dashboard_shares(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ShareResponse]:
    """List direct shares configured for a dashboard."""
    dashboard, _shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    shares = await get_resource_shares(ResourceType.dashboard, dashboard_id, db)
    return await resolve_share_responses(shares, db)


@router.patch("/{dashboard_id}/shares/{share_id}", response_model=ShareResponse)
@limiter.limit(WRITE_LIMIT)
async def update_dashboard_share(
    request: Request,
    dashboard_id: uuid.UUID,
    share_id: uuid.UUID,
    body: ShareUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> ShareResponse:
    """Change the role for an existing dashboard share."""
    dashboard, _shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await get_resource_share(ResourceType.dashboard, dashboard_id, share_id, db)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    if share.role == body.role:
        return (await resolve_share_responses([share], db))[0]
    share.role = body.role
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    notification_messages = await build_notification_messages(
        db,
        [n] if (n := stage_dashboard_share_notification(db, dashboard=dashboard, share=share, current_user=current_user, action="updated")) else [],
    )
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="updated"),
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, current_shares), *notification_fanouts(notification_messages)],
    )
    await db.refresh(share)
    return (await resolve_share_responses([share], db))[0]


@router.delete("/{dashboard_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_dashboard_share(
    request: Request,
    dashboard_id: uuid.UUID,
    share_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a direct share from a dashboard."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await get_resource_share(ResourceType.dashboard, dashboard_id, share_id, db)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    notification_messages = await build_notification_messages(
        db,
        [n] if (n := stage_dashboard_share_notification(db, dashboard=dashboard, share=share, current_user=current_user, action="removed")) else [],
    )
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_removed,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="removed"),
        client_id=client_id,
    )
    if share.principal_type == PrincipalType.user:
        user_result = await db.execute(select(User).where(User.id == share.principal_id))
        shared_user = user_result.scalar_one_or_none()
        if shared_user is not None:
            shared_user.preferences = remove_dashboard_from_preferences(shared_user.preferences, dashboard.id)
    await db.delete(share)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, shares), *notification_fanouts(notification_messages)],
    )


@router.post("/{dashboard_id}/owner", response_model=DashboardSummary)
@limiter.limit(WRITE_LIMIT)
async def transfer_dashboard_ownership(
    request: Request,
    dashboard_id: uuid.UUID,
    body: OwnerTransfer,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    """Hand the dashboard to a member; the caller stays on as an editor.

    Owner is the absence of a share row (ADR-001), so this is three writes in one transaction:
    the creator column moves, the new owner's grant goes, and the old owner gets an editor grant.
    The new owner must already be a member — inviting and promoting in one step would put someone
    in charge who never accepted anything.
    """
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    if body.user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You already own this dashboard")
    share = next((s for s in shares if s.principal_type == PrincipalType.user and s.principal_id == body.user_id), None)
    # A member deleting their account sheds this share and tombstones the row in one transaction,
    # and handing a dashboard to an account on its way out would strand it.
    if share is None or await lock_live_user(db, body.user_id) is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The new owner must already be a member of this dashboard")

    notification = stage_notification(
        db,
        user_id=body.user_id,
        type=EventType.dashboard_share_updated.value,
        title="Dashboard ownership transferred",
        body=f'{current_user.display_name} made you the owner of "{dashboard.name}".',
        reference_type="dashboard",
        reference_id=dashboard.id,
    )
    notification_messages = await build_notification_messages(db, [(body.user_id, notification)])
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "dashboard_name": dashboard.name,
            "changed_fields": [ChangedField.shares],
            "share_action": "transferred",
            "share_event_type": EventType.dashboard_share_updated.value,
            "share_id": str(share.id),
            "principal_type": str(share.principal_type),
            "principal_id": str(share.principal_id),
            "role": EffectiveRole.owner.value,
        },
        client_id=client_id,
    )
    dashboard.user_id = body.user_id
    await db.delete(share)
    await db.flush()
    await create_share(
        ResourceType.dashboard,
        dashboard.id,
        ShareCreate(principal_type=PrincipalType.user, principal_id=current_user.id, role=EffectiveRole.editor),
        granted_by=body.user_id,
        db=db,
    )
    # Audience from before the writes: both parties are members either way.
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, shares), *notification_fanouts(notification_messages)],
    )
    await db.refresh(dashboard)
    return to_summary(dashboard, "Shared directly with you", True, can_edit=True, can_manage_shares=False)


@router.delete("/{dashboard_id}/membership", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def leave_dashboard(
    request: Request,
    dashboard_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove the caller's own share — leave a dashboard they once accepted an invite to.

    Consent granted at redemption must stay withdrawable, or an accepted invite becomes a permanent
    claim on the member's account view. The server finds the share itself: `/shares` stays
    owner-only, and a member never learns share ids.
    """
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    if role is EffectiveRole.owner:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The owner cannot leave their own dashboard — delete it instead",
        )
    share = next(
        (s for s in shares if s.principal_type == PrincipalType.user and s.principal_id == current_user.id),
        None,
    )
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")

    # Same event as an owner removal, distinguished by share_action — the "joined" precedent.
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_removed,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="left"),
        client_id=client_id,
    )
    current_user.preferences = remove_dashboard_from_preferences(current_user.preferences, dashboard.id)
    await db.delete(share)
    # Audience computed before the delete, so the leaver's other tabs still get the frame and
    # drop the dashboard through the ordinary share_removed handling.
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
