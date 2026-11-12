"""Dashboard reads and response shaping shared by the dashboard routers."""

import uuid
from typing import Any

from sqlalchemy import case, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard, DashboardWidget
from app.models.share import PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.dashboards import DashboardResponse, DashboardSummary, WidgetResponseAdapter
from app.services import permissions
from app.services.activity import EventType, build_event_message
from app.services.preferences import favorite_dashboard_ids_from_preferences, remove_dashboard_from_preferences


async def load_widgets(dashboard_id: uuid.UUID, db: AsyncSession) -> list[DashboardWidget]:
    result = await db.execute(select(DashboardWidget).where(DashboardWidget.dashboard_id == dashboard_id).order_by(DashboardWidget.created_at))
    return list(result.scalars().all())


def to_summary(
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


def to_response(
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


async def list_accessible_dashboard_summaries(
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
            to_summary(
                dashboard,
                access_description,
                bool(is_shared),
                can_edit=permissions.can_edit(role),
                can_manage_shares=permissions.can_manage_shares(role),
                is_favorite=bool(is_favorite),
            )
        )
    return summaries


async def remove_dashboard_from_user_preferences(
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


async def build_dashboard_event_message(
    db: AsyncSession,
    *,
    event_type: EventType,
    current_user: User,
    dashboard: Dashboard,
    payload: dict[str, Any] | None = None,
    entity_type: str = "dashboard",
    entity_id: uuid.UUID | None = None,
    entity_version: int | None = None,
    client_id: str | None = None,
) -> dict:
    # Name every dashboard event after its dashboard: the feed renders "You rearranged widgets on
    # X", and a layout or widget write has no other reason to carry the name.
    return await build_event_message(
        db,
        event_type=event_type,
        current_user=current_user,
        dashboard=dashboard,
        entity_type=entity_type,
        entity_id=entity_id or dashboard.id,
        payload={"name": dashboard.name, **(payload or {})},
        client_id=client_id,
        entity_version=dashboard.version if entity_version is None else entity_version,
    )
