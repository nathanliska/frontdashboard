"""Shared helpers for resource-share access loading, CRUD, cleanup, and dashboard inheritance."""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, false, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard, DashboardWidget
from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.shares import (
    InheritedDashboardAccessResponse,
    ResourceAccessResponse,
    ShareCreate,
    ShareResponse,
)
from app.services import permissions


async def load_dashboard_access(
    dashboard_id: uuid.UUID,
    user: User,
    db: AsyncSession,
    *,
    lock_for_update: bool = False,
) -> tuple[Dashboard, list[ResourceShare], ShareRole | None]:
    # Dashboard-scoped resources load parent access through this helper, so a trashed dashboard
    # hides its child content everywhere at once. Trashed dashboards are invisible through this
    # door unconditionally; restore has its own owner-only loader (#40).
    dashboard_query = select(Dashboard).where(Dashboard.id == dashboard_id, Dashboard.deleted_at.is_(None))
    if lock_for_update:
        dashboard_query = dashboard_query.with_for_update()

    result = await db.execute(dashboard_query)
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


async def list_accessible_dashboard_ids(user: User, db: AsyncSession) -> list[uuid.UUID]:
    # Child-resource listing routes should source dashboard visibility from here
    # so trashed dashboards disappear consistently across future resource types.
    shared_ids_result = await db.execute(
        select(ResourceShare.resource_id).where(
            ResourceShare.resource_type == ResourceType.dashboard,
            ResourceShare.principal_type == PrincipalType.user,
            ResourceShare.principal_id == user.id,
        )
    )
    shared_ids = [row[0] for row in shared_ids_result.all()]

    result = await db.execute(
        select(Dashboard.id).where(
            Dashboard.deleted_at.is_(None),
            or_(
                Dashboard.user_id == user.id,
                Dashboard.id.in_(shared_ids) if shared_ids else false(),
            ),
        )
    )
    return [row[0] for row in result.all()]


async def load_resource_access(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    resource_created_by: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[list[ResourceShare], ShareRole | None]:
    """Load shares and compute effective access for the current user."""
    shares_result = await db.execute(
        select(ResourceShare).where(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
        )
    )
    shares = list(shares_result.scalars().all())

    if resource_created_by == user.id:
        return shares, None

    direct_role: ShareRole | None = None
    try:
        direct_role = permissions.effective_role(resource_created_by, user.id, shares)
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise

    # Dashboards are the *source* of inheritance, never a target: no widget binds a dashboard as
    # its resource, so inherited-role discovery for one is a structurally empty join — previously
    # paid on every non-owner dashboard access (finding #25).
    inherited_role = None
    if resource_type is not ResourceType.dashboard:
        inherited_role = await get_inherited_resource_role(
            resource_type,
            resource_id,
            user.id,
            db,
        )

    role = _highest_role([role for role in (direct_role, inherited_role) if role is not None])
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    return shares, role


async def cleanup_resource_shares(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    """Remove all shares for a resource (call before soft-deleting)."""
    await cleanup_resource_shares_for_many(resource_type, [resource_id], db)


async def cleanup_resource_shares_for_many(
    resource_type: ResourceType,
    resource_ids: list[uuid.UUID],
    db: AsyncSession,
) -> None:
    """One DELETE for a batch of same-type resources — dashboard deletion sweeps every child
    list and event, and issuing that per child was a statement per row (finding #25)."""
    if not resource_ids:
        return
    await db.execute(
        delete(ResourceShare).where(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id.in_(resource_ids),
        )
    )


async def get_resource_shares(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    db: AsyncSession,
) -> list[ResourceShare]:
    result = await db.execute(
        select(ResourceShare).where(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
        )
    )
    return list(result.scalars().all())


def _highest_role(roles: list[ShareRole]) -> ShareRole | None:
    for role in (ShareRole.editor, ShareRole.viewer):
        if role in roles:
            return role
    return None


def _dashboard_resource_role(dashboard_role: ShareRole | None) -> ShareRole:
    """Map dashboard access role to the inherited resource role."""
    if dashboard_role in (None, ShareRole.editor):
        return ShareRole.editor
    return ShareRole.viewer


async def get_shared_dashboards_for_resource(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    db: AsyncSession,
) -> list[tuple[Dashboard, list[ResourceShare]]]:
    dashboard_result = await db.execute(
        select(Dashboard)
        .join(DashboardWidget, DashboardWidget.dashboard_id == Dashboard.id)
        .where(
            Dashboard.deleted_at.is_(None),
            DashboardWidget.resource_type == resource_type,
            DashboardWidget.resource_id == resource_id,
        )
        .order_by(Dashboard.name.asc())
    )
    dashboards = list(dashboard_result.scalars().unique().all())
    if not dashboards:
        return []

    user_owned_dashboard_ids = [dashboard.id for dashboard in dashboards if dashboard.user_id is not None]
    shares_by_dashboard: dict[uuid.UUID, list[ResourceShare]] = {dashboard.id: [] for dashboard in dashboards}
    if user_owned_dashboard_ids:
        share_result = await db.execute(
            select(ResourceShare).where(
                ResourceShare.resource_type == ResourceType.dashboard,
                ResourceShare.resource_id.in_(user_owned_dashboard_ids),
            )
        )
        for share in share_result.scalars().all():
            shares_by_dashboard.setdefault(share.resource_id, []).append(share)

    return [(dashboard, shares_by_dashboard.get(dashboard.id, [])) for dashboard in dashboards if shares_by_dashboard.get(dashboard.id)]


async def list_inherited_dashboard_user_ids(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    db: AsyncSession,
) -> list[uuid.UUID]:
    return list(
        {
            user_id
            for dashboard, dashboard_shares in await get_shared_dashboards_for_resource(
                resource_type,
                resource_id,
                db,
            )
            for user_id in {
                dashboard.user_id,
                *(share.principal_id for share in dashboard_shares if share.principal_type == PrincipalType.user),
            }
            if user_id is not None
        }
    )


async def get_inherited_resource_role(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> ShareRole | None:
    inherited_roles: list[ShareRole] = []
    for dashboard, dashboard_shares in await get_shared_dashboards_for_resource(
        resource_type,
        resource_id,
        db,
    ):
        # Explicit no-access handling. This used to go through a wrapper that returned None for
        # BOTH "owner" and "no access" and then disambiguated by re-checking ownership — the
        # ambiguity #18 exists to remove.
        try:
            dashboard_role = permissions.effective_role(dashboard.user_id, user_id, dashboard_shares)
        except HTTPException:
            continue  # this binding dashboard grants the user nothing
        inherited_roles.append(_dashboard_resource_role(dashboard_role))

    return _highest_role(inherited_roles)


async def list_dashboard_managed_resource_ids_for_user(
    resource_type: ResourceType,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> set[uuid.UUID]:
    matching_dashboard_ids = select(ResourceShare.resource_id).where(
        ResourceShare.resource_type == ResourceType.dashboard,
        ResourceShare.principal_type == PrincipalType.user,
        ResourceShare.principal_id == user_id,
    )
    all_shared_dashboard_ids = select(ResourceShare.resource_id).where(
        ResourceShare.resource_type == ResourceType.dashboard,
    )

    accessible_dashboard_result = await db.execute(
        select(Dashboard.id).where(
            Dashboard.deleted_at.is_(None),
            or_(
                Dashboard.id.in_(matching_dashboard_ids),
                and_(
                    Dashboard.user_id == user_id,
                    Dashboard.id.in_(all_shared_dashboard_ids),
                ),
            ),
        )
    )
    dashboard_ids = [row[0] for row in accessible_dashboard_result.all()]
    if not dashboard_ids:
        return set()

    resource_result = await db.execute(
        select(DashboardWidget.resource_id).where(
            DashboardWidget.dashboard_id.in_(dashboard_ids),
            DashboardWidget.resource_type == resource_type,
            DashboardWidget.resource_id.is_not(None),
        )
    )
    return {row[0] for row in resource_result.all() if row[0] is not None}


async def get_resource_share(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    share_id: uuid.UUID,
    db: AsyncSession,
) -> ResourceShare | None:
    result = await db.execute(
        select(ResourceShare).where(
            ResourceShare.id == share_id,
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
        )
    )
    return result.scalar_one_or_none()


async def insert_shares(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    share_inputs: list[ShareCreate],
    granted_by: uuid.UUID,
    db: AsyncSession,
) -> None:
    """Bulk-insert share rows. Silently ignores duplicates via ON CONFLICT DO NOTHING."""
    from datetime import UTC, datetime

    if not share_inputs:
        return

    rows = [
        {
            "id": uuid.uuid4(),
            "resource_type": resource_type,
            "resource_id": resource_id,
            "principal_type": s.principal_type,
            "principal_id": s.principal_id,
            "role": s.role,
            "granted_by": granted_by,
            "created_at": datetime.now(UTC),
        }
        for s in share_inputs
    ]
    stmt = pg_insert(ResourceShare).values(rows).on_conflict_do_nothing(constraint="uq_resource_shares_target")
    await db.execute(stmt)


async def create_share(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    share_input: ShareCreate,
    granted_by: uuid.UUID,
    db: AsyncSession,
) -> ResourceShare:
    """Grant, or re-grant at a new role, in one statement.

    This was a read-then-insert, which is a race with itself: two grants of the same target
    interleaving between the SELECT and the INSERT both decide the row is absent, and the loser
    surfaces as a bare `IntegrityError` — a 500 for what is a supported operation (finding #19).
    A single upsert on `uq_resource_shares_target` makes "already shared" the database's problem
    rather than a window in ours, and keeps the same semantics: an existing grant has its role
    replaced, an absent one is created.
    """
    stmt = (
        pg_insert(ResourceShare)
        .values(
            resource_type=resource_type,
            resource_id=resource_id,
            principal_type=share_input.principal_type,
            principal_id=share_input.principal_id,
            role=share_input.role,
            granted_by=granted_by,
        )
        .on_conflict_do_update(
            constraint="uq_resource_shares_target",
            # Role only: `granted_by` and `created_at` stay with the original grant, which is what
            # the read-then-write path did and what the activity trail reads back.
            set_={"role": share_input.role},
        )
        .returning(ResourceShare)
    )
    # populate_existing: the conflicting row may already be in the identity map holding the old
    # role, and the returned row is the authoritative one.
    result = await db.execute(stmt, execution_options={"populate_existing": True})
    return result.scalars().one()


async def resource_is_visible_to_principal(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    principal_type: PrincipalType,
    principal_id: uuid.UUID,
    db: AsyncSession,
) -> bool:
    """Whether a resource is directly visible to a principal in audience terms.

    A user principal can satisfy visibility by owning the resource or by having
    a direct user share.
    """

    owner_query = None
    if resource_type == ResourceType.list:
        from app.models.list import List

        owner_query = select(List.created_by).where(List.id == resource_id, List.deleted_at.is_(None))
    elif resource_type == ResourceType.calendar_event:
        from app.models.calendar import CalendarEvent

        owner_query = select(CalendarEvent.created_by).where(CalendarEvent.id == resource_id, CalendarEvent.deleted_at.is_(None))

    if owner_query is not None:
        owner_result = await db.execute(owner_query)
        owner_id = owner_result.scalar_one_or_none()
        if owner_id == principal_id:
            return True

    share_result = await db.execute(
        select(ResourceShare.id).where(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
            ResourceShare.principal_type == principal_type,
            ResourceShare.principal_id == principal_id,
        )
    )
    return share_result.scalar_one_or_none() is not None


async def resolve_share_responses(
    shares: list[ResourceShare],
    db: AsyncSession,
) -> list[ShareResponse]:
    """Resolve principal_name for each share."""
    from app.models.user import User as UserModel

    user_ids = {s.principal_id for s in shares if s.principal_type == PrincipalType.user}

    users_by_id: dict[uuid.UUID, str] = {}

    if user_ids:
        ur = await db.execute(select(UserModel.id, UserModel.display_name).where(UserModel.id.in_(user_ids)))
        users_by_id = {row[0]: row[1] for row in ur.all()}

    result = []
    for s in shares:
        result.append(
            ShareResponse(
                id=s.id,
                resource_type=s.resource_type,
                resource_id=s.resource_id,
                principal_type=s.principal_type,
                principal_id=s.principal_id,
                principal_name=users_by_id.get(s.principal_id, "Unknown"),
                role=s.role,
                granted_by=s.granted_by,
                created_at=s.created_at,
            )
        )
    return result


async def resolve_resource_access_response(
    resource_type: ResourceType,
    resource_id: uuid.UUID,
    db: AsyncSession,
) -> ResourceAccessResponse:
    shares = await get_resource_shares(resource_type, resource_id, db)
    inherited_dashboards = [
        InheritedDashboardAccessResponse(
            dashboard_id=dashboard.id,
            dashboard_name=dashboard.name,
        )
        for dashboard, _dashboard_shares in await get_shared_dashboards_for_resource(
            resource_type,
            resource_id,
            db,
        )
    ]
    return ResourceAccessResponse(
        direct_shares=await resolve_share_responses(shares, db),
        inherited_dashboards=inherited_dashboards,
    )
