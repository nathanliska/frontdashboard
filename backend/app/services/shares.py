"""Shared helpers for resource-share access loading and CRUD.

Only dashboards carry share rows ([ADR-001](../../../docs/adr/ADR-001-per-resource-sharing.md)),
and since #19 the database says so: `ck_resource_shares_resource_type` pins `resource_type` to
`'dashboard'`, which is what lets `resource_id` have a real foreign key. The `resource_type`
arguments below are therefore always `ResourceType.dashboard` — kept as parameters because they are
genuinely part of the queries' WHERE clauses, not because more types can arrive without a migration.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import false, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard
from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.shares import ShareCreate, ShareResponse
from app.services import permissions


def dashboard_audience_user_ids(dashboard: Dashboard, shares: list[ResourceShare]) -> set[uuid.UUID]:
    """Everyone entitled to an SSE event about this dashboard, or about a list or event bound to it.

    The owner plus every user principal. Lists and calendar events inherit access from the dashboard
    (ADR-001), so they share this audience rather than computing their own — broadcasting to too few
    users is the failure that matters, since the missed tab shows stale data with nothing to
    indicate it (backend/CLAUDE.md).
    """
    return {dashboard.user_id} | {share.principal_id for share in shares if share.principal_type == PrincipalType.user}


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
