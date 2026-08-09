"""Shared helpers for resource-share access loading and CRUD.

Only dashboards carry share rows (ADR-001), and a CHECK constraint says so. The `resource_type`
arguments below are always `ResourceType.dashboard`; they stay parameters because they are part
of the queries' WHERE clauses, not because more types can arrive without a migration.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import false, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard
from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.shares import DashboardMemberResponse, ShareCreate, ShareResponse
from app.services import permissions


def dashboard_audience_user_ids(dashboard: Dashboard, shares: list[ResourceShare]) -> set[uuid.UUID]:
    """Everyone entitled to an SSE event about this dashboard, or a list or event bound to it.

    The owner plus every user principal. Children inherit access (ADR-001), so they share this
    audience — broadcasting too narrowly leaves a tab stale with nothing to indicate it.
    """
    return {dashboard.user_id} | {share.principal_id for share in shares if share.principal_type == PrincipalType.user}


async def load_dashboard_access(
    dashboard_id: uuid.UUID,
    user: User,
    db: AsyncSession,
    *,
    lock_for_update: bool = False,
) -> tuple[Dashboard, list[ResourceShare], EffectiveRole]:
    # Every dashboard-scoped resource loads access through here, so trashing hides child content
    # everywhere at once. Restore has its own owner-only loader.
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
) -> tuple[list[ResourceShare], EffectiveRole]:
    """Load shares and compute effective access for the current user."""
    shares_result = await db.execute(
        select(ResourceShare).where(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == resource_id,
        )
    )
    shares = list(shares_result.scalars().all())

    # Direct grants are the whole story: a list or event belongs to exactly one dashboard and its
    # router resolves access from `dashboard_id`, so there is no inherited role to join for here.
    return shares, permissions.effective_role(resource_created_by, user.id, shares)


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

    An upsert on `uq_resource_shares_target`, because a read-then-insert races itself: two grants
    of the same target both find the row absent, and the loser 500s on a bare IntegrityError.
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


async def resolve_member_responses(
    dashboard: Dashboard,
    shares: list[ResourceShare],
    db: AsyncSession,
) -> list[DashboardMemberResponse]:
    """Everyone with access, named: the same set `dashboard_audience_user_ids` addresses.

    Owner first, then members by display name — a stable order for a picker.
    """
    member_ids = {s.principal_id for s in shares if s.principal_type == PrincipalType.user}

    names_result = await db.execute(select(User.id, User.display_name).where(User.id.in_([dashboard.user_id, *member_ids])))
    name_by_id = {row[0]: row[1] for row in names_result.all()}

    members = [DashboardMemberResponse(user_id=user_id, display_name=name_by_id[user_id]) for user_id in member_ids]
    members.sort(key=lambda member: member.display_name.casefold())
    owner = DashboardMemberResponse(user_id=dashboard.user_id, display_name=name_by_id[dashboard.user_id])
    return [owner, *members]


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
