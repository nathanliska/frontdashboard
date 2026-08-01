import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import ValidationError
from sqlalchemy import case, func, literal, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.config import settings
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
from app.models.dashboard import Dashboard, DashboardWidget
from app.models.list import List, ListType
from app.models.notification import Notification
from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.dashboards import (
    WIDGET_CONFIG_MODELS,
    DashboardCreate,
    DashboardResponse,
    DashboardSummary,
    DashboardUpdate,
    LayoutUpdate,
    ListWidgetCreate,
    TrashedDashboardSummary,
    WidgetConfigUpdate,
    WidgetCreate,
    WidgetResponse,
    WidgetResponseAdapter,
)
from app.schemas.shares import ShareCreate, ShareResponse, ShareUpdate
from app.services import permissions
from app.services.activity import EventType, log_event
from app.services.notifications import stage_notification
from app.services.preferences import (
    favorite_dashboard_ids_from_preferences,
    remove_dashboard_from_preferences,
)
from app.services.shares import (
    create_share,
    dashboard_audience_user_ids,
    get_resource_share,
    get_resource_shares,
    insert_shares,
    load_dashboard_access,
    resolve_share_responses,
)
from app.sse.choreography import Fanout, commit_and_broadcast
from app.sse.events import build_activity_sse_dict, build_notification_sse_dicts

router = APIRouter(prefix="/dashboards", tags=["dashboards"])
ClientMutationIdHeader = Annotated[str | None, Header(alias="X-Client-Mutation-Id", max_length=128)]
_INVALID_SHARE_TARGET_DETAIL = "Share targets must be active verified users other than the owner"


async def _load_widgets(dashboard_id: uuid.UUID, db: AsyncSession) -> list[DashboardWidget]:
    result = await db.execute(select(DashboardWidget).where(DashboardWidget.dashboard_id == dashboard_id).order_by(DashboardWidget.created_at))
    return list(result.scalars().all())


def _to_summary(
    dashboard: Dashboard,
    access_description: str | None = None,
    is_shared: bool = False,
    *,
    can_edit: bool = True,
    can_manage_shares: bool = True,
    is_favorite: bool = False,
) -> DashboardSummary:
    return DashboardSummary.model_validate(
        {
            "id": dashboard.id,
            "user_id": dashboard.user_id,
            "name": dashboard.name,
            "access_description": access_description,
            "is_shared": is_shared,
            "can_edit": can_edit,
            "can_manage_shares": can_manage_shares,
            "is_favorite": is_favorite,
            "version": dashboard.version,
            "created_at": dashboard.created_at,
            "updated_at": dashboard.updated_at,
        }
    )


def _to_response(
    dashboard: Dashboard,
    widgets: list[DashboardWidget],
    is_shared: bool,
    *,
    can_edit: bool = True,
    can_manage_shares: bool = True,
    is_favorite: bool = False,
) -> DashboardResponse:
    layout = dashboard.layout if isinstance(dashboard.layout, list) else []
    return DashboardResponse(
        id=dashboard.id,
        user_id=dashboard.user_id,
        name=dashboard.name,
        is_shared=is_shared,
        can_edit=can_edit,
        can_manage_shares=can_manage_shares,
        is_favorite=is_favorite,
        layout=layout,
        version=dashboard.version,
        widgets=[WidgetResponseAdapter.validate_python(w) for w in widgets],
    )


def _next_y(layout: list[dict[str, Any]]) -> int:
    if not layout:
        return 0
    return max(item.get("y", 0) + item.get("h", 1) for item in layout)


def _default_widget_size(widget_type: str) -> tuple[int, int]:
    if widget_type == "calendar":
        return (3, 3)
    return (4, 4)


async def _resource_shares_by_dashboard(
    dashboard_ids: list[uuid.UUID],
    db: AsyncSession,
) -> dict[uuid.UUID, list[ResourceShare]]:
    shares_by_dashboard: dict[uuid.UUID, list[ResourceShare]] = {dashboard_id: [] for dashboard_id in dashboard_ids}
    if not dashboard_ids:
        return shares_by_dashboard

    shares_result = await db.execute(
        select(ResourceShare).where(
            ResourceShare.resource_type == ResourceType.dashboard,
            ResourceShare.resource_id.in_(dashboard_ids),
        )
    )
    for share in shares_result.scalars().all():
        shares_by_dashboard.setdefault(share.resource_id, []).append(share)
    return shares_by_dashboard


async def _list_accessible_dashboard_summaries(
    user: User,
    db: AsyncSession,
) -> list[DashboardSummary]:
    favorite_dashboard_ids = favorite_dashboard_ids_from_preferences(user.preferences)
    direct_share_exists = (
        select(ResourceShare.id)
        .where(
            ResourceShare.resource_type == ResourceType.dashboard,
            ResourceShare.resource_id == Dashboard.id,
            ResourceShare.principal_type == PrincipalType.user,
            ResourceShare.principal_id == user.id,
        )
        .exists()
    )
    any_share_exists = (
        select(ResourceShare.id)
        .where(
            ResourceShare.resource_type == ResourceType.dashboard,
            ResourceShare.resource_id == Dashboard.id,
        )
        .exists()
    )
    access_description = case(
        (Dashboard.user_id == user.id, literal("Owned by you")),
        (direct_share_exists, literal("Shared directly with you")),
        else_=literal("Shared with you"),
    ).label("access_description")
    favorite_for_user = (
        case(
            (Dashboard.id.in_(favorite_dashboard_ids), literal(True)),
            else_=literal(False),
        )
        if favorite_dashboard_ids
        else literal(False)
    ).label("is_favorite")

    result = await db.execute(
        select(
            Dashboard,
            access_description,
            any_share_exists.label("is_shared"),
            favorite_for_user,
        )
        .where(
            Dashboard.deleted_at.is_(None),
            or_(
                Dashboard.user_id == user.id,
                direct_share_exists,
            ),
        )
        .order_by(favorite_for_user.desc(), Dashboard.updated_at.desc())
    )
    rows = result.all()
    shares_by_dashboard = await _resource_shares_by_dashboard(
        [dashboard.id for dashboard, _access_description, _is_shared, _is_favorite in rows],
        db,
    )
    summaries: list[DashboardSummary] = []
    for dashboard, access_description, is_shared, is_favorite in rows:
        # The WHERE above admits only owned or directly-shared rows, so this cannot 404;
        # if filter and computation ever disagree, that is a bug worth a loud failure.
        role = permissions.effective_role(dashboard.user_id, user.id, shares_by_dashboard.get(dashboard.id, []))
        summaries.append(
            _to_summary(
                dashboard,
                access_description,
                bool(is_shared),
                can_edit=permissions.can_edit(role),
                can_manage_shares=permissions.can_manage_shares(role),
                is_favorite=bool(is_favorite),
            )
        )
    return summaries


async def _validate_share_targets(
    share_inputs: list[ShareCreate],
    owner_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    target_ids = {share.principal_id for share in share_inputs}
    if not target_ids:
        return
    if owner_id in target_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=_INVALID_SHARE_TARGET_DETAIL,
        )

    result = await db.execute(
        select(User.id).where(
            User.id.in_(target_ids),
            User.deleted_at.is_(None),
            User.email_verified_at.is_not(None),
        )
    )
    if set(result.scalars()) != target_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=_INVALID_SHARE_TARGET_DETAIL,
        )


async def _remove_dashboard_from_user_preferences(
    dashboard: Dashboard,
    shares: list[ResourceShare],
    db: AsyncSession,
) -> None:
    candidate_user_ids: set[uuid.UUID] = {dashboard.user_id}
    candidate_user_ids.update(share.principal_id for share in shares if share.principal_type == PrincipalType.user)
    if not candidate_user_ids:
        return

    result = await db.execute(select(User).where(User.id.in_(candidate_user_ids)))
    for user in result.scalars().all():
        user.preferences = remove_dashboard_from_preferences(user.preferences, dashboard.id)


def _dashboard_fanout(message: dict, dashboard: Dashboard, shares: list[ResourceShare]) -> Fanout:
    """Address a frame to everyone who can see the dashboard, owner included."""
    return Fanout(message, dashboard_audience_user_ids(dashboard, shares))


async def _build_dashboard_event_message(
    db: AsyncSession,
    *,
    event_type: EventType,
    current_user: User,
    dashboard: Dashboard,
    payload: dict[str, Any] | None = None,
    entity_type: str = "dashboard",
    entity_id: uuid.UUID | None = None,
    entity_version: int | None = None,
    client_mutation_id: str | None = None,
) -> dict:
    event_payload = {"dashboard_id": str(dashboard.id), **(payload or {})}
    if client_mutation_id is not None:
        event_payload["client_mutation_id"] = client_mutation_id
    activity = log_event(
        db,
        event_type=event_type,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type=entity_type,
        entity_id=entity_id or dashboard.id,
        entity_version=dashboard.version if entity_version is None else entity_version,
        payload=event_payload,
    )
    return await build_activity_sse_dict(db, activity)


def _dashboard_share_event_payload(
    dashboard: Dashboard,
    share: ResourceShare,
    action: str,
) -> dict[str, Any]:
    return {
        "dashboard_name": dashboard.name,
        "changed_fields": ["shares"],
        "share_action": action,
        "share_event_type": f"dashboard.share_{action}",
        "share_id": str(share.id),
        "principal_type": str(share.principal_type),
        "principal_id": str(share.principal_id),
        "role": str(share.role),
    }


def _dashboard_share_event_type(action: str) -> EventType:
    if action == "added":
        return EventType.dashboard_share_added
    if action == "updated":
        return EventType.dashboard_share_updated
    return EventType.dashboard_share_removed


def _dashboard_share_notification_copy(
    *,
    action: str,
    actor_name: str,
    dashboard_name: str,
    role: ShareRole,
) -> tuple[str, str]:
    if action == "added":
        return (
            "Dashboard shared with you",
            f'{actor_name} gave you {role.value} access to "{dashboard_name}".',
        )
    if action == "updated":
        return (
            "Dashboard access updated",
            f'{actor_name} changed your access to "{dashboard_name}" to {role.value}.',
        )
    return (
        "Dashboard access removed",
        f'{actor_name} removed your access to "{dashboard_name}".',
    )


def _stage_dashboard_share_notification(
    db: AsyncSession,
    *,
    dashboard: Dashboard,
    share: ResourceShare,
    current_user: User,
    action: str,
) -> tuple[uuid.UUID, Notification] | None:
    if share.principal_type != PrincipalType.user or share.principal_id == current_user.id:
        return None

    title, body = _dashboard_share_notification_copy(
        action=action,
        actor_name=current_user.display_name,
        dashboard_name=dashboard.name,
        role=ShareRole(share.role),
    )
    notification = stage_notification(
        db,
        user_id=share.principal_id,
        type=_dashboard_share_event_type(action).value,
        title=title,
        body=body,
        reference_type="dashboard",
        reference_id=dashboard.id,
    )
    return share.principal_id, notification


def _collect_dashboard_share_notifications(
    db: AsyncSession,
    *,
    dashboard: Dashboard,
    shares: list[ResourceShare],
    current_user: User,
    action: str,
) -> list[tuple[uuid.UUID, Notification]]:
    notifications: list[tuple[uuid.UUID, Notification]] = []
    for share in shares:
        notification = _stage_dashboard_share_notification(
            db,
            dashboard=dashboard,
            share=share,
            current_user=current_user,
            action=action,
        )
        if notification is not None:
            notifications.append(notification)
    return notifications


async def _build_dashboard_share_notification_messages(
    db: AsyncSession,
    notifications: list[tuple[uuid.UUID, Notification]],
) -> list[tuple[uuid.UUID, dict]]:
    if not notifications:
        return []

    messages = await build_notification_sse_dicts(
        db,
        [notification for _user_id, notification in notifications],
    )
    return [(user_id, message) for (user_id, _notification), message in zip(notifications, messages, strict=True)]


def _notification_fanouts(messages: list[tuple[uuid.UUID, dict]]) -> list[Fanout]:
    """One frame per recipient: a notification is addressed, not fanned out to the audience."""
    return [Fanout(message, {user_id}) for user_id, message in messages]


@router.get("", response_model=list[DashboardSummary])
async def list_dashboards(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DashboardSummary]:
    """List dashboards the current user owns or can access."""
    return await _list_accessible_dashboard_summaries(current_user, db)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=DashboardSummary)
@limiter.limit(WRITE_LIMIT)
async def create_dashboard(
    request: Request,
    body: DashboardCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    """Create a dashboard and apply any initial shares."""
    await _validate_share_targets(body.shares, current_user.id, db)
    dashboard = Dashboard(user_id=current_user.id, name=body.name)
    db.add(dashboard)
    await db.flush()
    await insert_shares(ResourceType.dashboard, dashboard.id, body.shares, current_user.id, db)
    shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    notification_messages = await _build_dashboard_share_notification_messages(
        db,
        _collect_dashboard_share_notifications(
            db,
            dashboard=dashboard,
            shares=shares,
            current_user=current_user,
            action="added",
        ),
    )
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_created,
        current_user=current_user,
        dashboard=dashboard,
        payload={"name": dashboard.name},
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares), *_notification_fanouts(notification_messages)],
    )
    await db.refresh(dashboard)
    return _to_summary(
        dashboard,
        "Owned by you",
        bool(shares),
        can_edit=True,
        can_manage_shares=True,
    )


@router.patch("/{dashboard_id}", response_model=DashboardSummary)
@limiter.limit(WRITE_LIMIT)
async def update_dashboard_meta(
    request: Request,
    dashboard_id: uuid.UUID,
    body: DashboardUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    """Update dashboard metadata (currently just the name)."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    if body.name is not None:
        permissions.assert_can_edit(role)
        dashboard.name = body.name
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "name": dashboard.name,
            "changed_fields": sorted(body.model_fields_set),
        },
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(dashboard)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    access_description = "Owned by you" if dashboard.user_id == current_user.id else "Shared directly with you"
    return _to_summary(
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
    client_mutation_id: ClientMutationIdHeader = None,
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
    await _remove_dashboard_from_user_preferences(dashboard, shares, db)
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_deleted,
        current_user=current_user,
        dashboard=dashboard,
        payload={"name": dashboard.name},
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
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
    client_mutation_id: ClientMutationIdHeader = None,
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
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={"changed_fields": ["restored"]},
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(dashboard)
    return _to_summary(
        dashboard,
        "Owned by you",
        bool(shares),
        can_edit=True,
        can_manage_shares=True,
        is_favorite=False,
    )


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    """Return a dashboard with its widgets and access metadata."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    widgets = await _load_widgets(dashboard.id, db)
    return _to_response(
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
    client_mutation_id: ClientMutationIdHeader = None,
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
    # Dump to plain dicts for the JSON column; model_dump also drops the transient
    # react-grid-layout bookkeeping keys the client round-trips (see LayoutItem).
    dashboard.layout = [item.model_dump() for item in body.layout]
    dashboard.version += 1
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={"version": dashboard.version, "changed_fields": ["layout"]},
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(dashboard)
    widgets = await _load_widgets(dashboard.id, db)
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    return _to_response(
        dashboard,
        widgets,
        bool(current_shares),
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )


@router.post("/{dashboard_id}/widgets", status_code=status.HTTP_201_CREATED, response_model=DashboardResponse)
@limiter.limit(WRITE_LIMIT)
async def add_widget(
    request: Request,
    dashboard_id: uuid.UUID,
    body: WidgetCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardResponse:
    """Add a widget to a dashboard, creating bound resources when needed."""
    # Lock the dashboard row so concurrent widget/layout mutations can't lose version/layout updates.
    dashboard, shares, role = await load_dashboard_access(
        dashboard_id,
        current_user,
        db,
        lock_for_update=True,
    )
    permissions.assert_can_edit(role)
    is_shared_dashboard = bool(shares)
    # exclude_unset so omitted fields stay absent rather than landing as explicit nulls; extras
    # survive because every config model is extra="allow".
    widget_config = body.config.model_dump(exclude_unset=True)
    resource_type: str | None = None
    resource_id: uuid.UUID | None = None

    # A schema fact: only ListWidgetCreate carries resource fields, and they are a 422 on any
    # other variant (extra="forbid").
    if isinstance(body, ListWidgetCreate):
        resource_type = ResourceType.list.value
        resource_id = body.resource_id
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

            # Computed over the same set GET /lists orders, or the append doesn't land last.
            max_order_result = await db.execute(
                select(func.max(List.sort_order)).where(
                    List.dashboard_id == dashboard.id,
                    List.deleted_at.is_(None),
                )
            )
            next_order = (max_order_result.scalar_one() or -1) + 1

            created_list = List(
                dashboard_id=dashboard.id,
                created_by=current_user.id,
                updated_by=current_user.id,
                name=list_name,
                list_type=list_type,
                sort_order=next_order,
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

        # One list maps to at most one widget per dashboard. The unique index enforces it; this
        # check exists for the friendly 409.
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
    default_w, default_h = _default_widget_size(body.widget_type)
    dashboard.layout = current_layout + [
        {
            "i": str(widget.id),
            "x": 0,
            "y": _next_y(current_layout),
            "w": default_w,
            "h": default_h,
        }
    ]
    dashboard.version += 1
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "widget_id": str(widget.id),
            "widget_type": widget.widget_type,
            "resource_type": widget.resource_type,
            "resource_id": str(widget.resource_id) if widget.resource_id else None,
            "changed_fields": ["widgets", "layout"],
        },
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(dashboard)
    widgets = await _load_widgets(dashboard.id, db)
    return _to_response(
        dashboard,
        widgets,
        is_shared_dashboard,
        can_edit=permissions.can_edit(role),
        can_manage_shares=permissions.can_manage_shares(role),
        is_favorite=dashboard.id in set(favorite_dashboard_ids_from_preferences(current_user.preferences)),
    )


@router.patch("/{dashboard_id}/widgets/{widget_id}", response_model=WidgetResponse)
@limiter.limit(WRITE_LIMIT)
async def update_widget(
    request: Request,
    dashboard_id: uuid.UUID,
    widget_id: uuid.UUID,
    body: WidgetConfigUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
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
    event_message = await _build_dashboard_event_message(
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
            "changed_fields": ["widgets"],
        },
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    await db.refresh(widget)
    return WidgetResponseAdapter.validate_python(widget)


@router.delete("/{dashboard_id}/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_widget(
    request: Request,
    dashboard_id: uuid.UUID,
    widget_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
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
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "widget_id": str(widget.id),
            "widget_type": widget.widget_type,
            "changed_fields": ["widgets", "layout"],
        },
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )


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


@router.post("/{dashboard_id}/shares", status_code=status.HTTP_201_CREATED, response_model=ShareResponse)
@limiter.limit(WRITE_LIMIT)
async def add_dashboard_share(
    request: Request,
    dashboard_id: uuid.UUID,
    body: ShareCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> ShareResponse:
    """Create or upsert a direct share on a dashboard."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    await _validate_share_targets([body], dashboard.user_id, db)
    existing_share = next(
        (share for share in shares if share.principal_type == body.principal_type and share.principal_id == body.principal_id),
        None,
    )
    if existing_share is not None and existing_share.role == body.role:
        return (await resolve_share_responses([existing_share], db))[0]

    share = await create_share(ResourceType.dashboard, dashboard_id, body, current_user.id, db)
    action = "updated" if existing_share is not None else "added"
    current_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    notification_messages = await _build_dashboard_share_notification_messages(
        db,
        _collect_dashboard_share_notifications(
            db,
            dashboard=dashboard,
            shares=[share],
            current_user=current_user,
            action=action,
        ),
    )
    event_message = await _build_dashboard_event_message(
        db,
        event_type=_dashboard_share_event_type(action),
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(
            dashboard,
            share,
            action=action,
        ),
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, current_shares), *_notification_fanouts(notification_messages)],
    )
    return (await resolve_share_responses([share], db))[0]


@router.patch("/{dashboard_id}/shares/{share_id}", response_model=ShareResponse)
@limiter.limit(WRITE_LIMIT)
async def update_dashboard_share(
    request: Request,
    dashboard_id: uuid.UUID,
    share_id: uuid.UUID,
    body: ShareUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_mutation_id: ClientMutationIdHeader = None,
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
    notification_messages = await _build_dashboard_share_notification_messages(
        db,
        _collect_dashboard_share_notifications(
            db,
            dashboard=dashboard,
            shares=[share],
            current_user=current_user,
            action="updated",
        ),
    )
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="updated"),
        client_mutation_id=client_mutation_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, current_shares), *_notification_fanouts(notification_messages)],
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
    client_mutation_id: ClientMutationIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a direct share from a dashboard."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await get_resource_share(ResourceType.dashboard, dashboard_id, share_id, db)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    notification_messages = await _build_dashboard_share_notification_messages(
        db,
        _collect_dashboard_share_notifications(
            db,
            dashboard=dashboard,
            shares=[share],
            current_user=current_user,
            action="removed",
        ),
    )
    event_message = await _build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_removed,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="removed"),
        client_mutation_id=client_mutation_id,
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
        fanouts=[_dashboard_fanout(event_message, dashboard, shares), *_notification_fanouts(notification_messages)],
    )
