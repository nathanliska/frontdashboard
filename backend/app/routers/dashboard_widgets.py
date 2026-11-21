import uuid
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
from app.models.dashboard import DashboardWidget
from app.models.list import List
from app.models.user import User
from app.schemas.dashboards import (
    WIDGET_CONFIG_MODELS,
    DashboardResponse,
    ListWidgetCreate,
    WidgetAddedResponse,
    WidgetConfigUpdate,
    WidgetCreate,
    WidgetResponse,
    WidgetResponseAdapter,
    minimum_widget_size,
)
from app.schemas.lists import ListResponse
from app.services import permissions
from app.services.activity import EventType
from app.services.dashboard_widgets import bind_list_widget, default_widget_size, fit_widget
from app.services.dashboards import (
    build_dashboard_event_message,
    load_widgets,
    to_response,
)
from app.services.preferences import (
    favorite_dashboard_ids_from_preferences,
)
from app.services.quota import assert_under_quota, limit_message
from app.services.shares import (
    dashboard_fanout,
    load_dashboard_access,
)
from app.sse.choreography import ClientIdHeader, commit_and_broadcast

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


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
    list_id: uuid.UUID | None = None
    created_list: List | None = None

    # A schema fact: only ListWidgetCreate carries `list_id`, and it is a 422 on any other
    # variant (extra="forbid").
    if isinstance(body, ListWidgetCreate):
        list_id, created_list, widget_config = await bind_list_widget(
            db,
            dashboard=dashboard,
            current_user=current_user,
            list_id=body.list_id,
            widget_config=widget_config,
        )

    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        widget_type=body.widget_type,
        config=widget_config,
        list_id=list_id,
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
            "list_id": str(widget.list_id) if widget.list_id else None,
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
