import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.models.dashboard import Dashboard
from app.models.group import DashboardRole, Group, GroupMember, GroupRole
from app.models.invite import Invite
from app.models.user import User
from app.schemas.groups import (
    GroupCreate,
    GroupResponse,
    GroupUpdate,
    MemberResponse,
    MemberRoleUpdate,
)
from app.schemas.invites import InviteCreate, InviteResponse

router = APIRouter(prefix="/api/groups", tags=["groups"])


# ---------------------------------------------------------------------------
# Permission helpers
# ---------------------------------------------------------------------------


async def _get_membership(group_id: uuid.UUID, user: User, db: AsyncSession) -> GroupMember:
    result = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user.id,
            GroupMember.left_at.is_(None),
        )
    )
    membership = result.scalar_one_or_none()
    if not membership:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return membership


def _assert_admin(membership: GroupMember) -> None:
    if membership.role not in (GroupRole.admin, GroupRole.owner):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin or owner required")


def _assert_owner(membership: GroupMember) -> None:
    if membership.role != GroupRole.owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner required")


async def _count_active_owners(group_id: uuid.UUID, db: AsyncSession) -> int:
    result = await db.execute(
        select(func.count(GroupMember.id)).where(
            GroupMember.group_id == group_id,
            GroupMember.role == GroupRole.owner,
            GroupMember.left_at.is_(None),
        )
    )
    return result.scalar_one()


async def _get_member_count(group_id: uuid.UUID, db: AsyncSession) -> int:
    result = await db.execute(
        select(func.count(GroupMember.id)).where(
            GroupMember.group_id == group_id,
            GroupMember.left_at.is_(None),
        )
    )
    return result.scalar_one()


def _group_response(group: Group, member_count: int) -> GroupResponse:
    return GroupResponse(
        id=group.id,
        name=group.name,
        created_by=group.created_by,
        settings=group.settings,
        created_at=group.created_at,
        member_count=member_count,
    )


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------


@router.post("", status_code=status.HTTP_201_CREATED, response_model=GroupResponse)
async def create_group(
    body: GroupCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GroupResponse:
    group = Group(name=body.name, created_by=current_user.id)
    db.add(group)
    await db.flush()

    db.add(
        GroupMember(
            group_id=group.id,
            user_id=current_user.id,
            role=GroupRole.owner,
            joined_at=datetime.now(UTC),
        )
    )
    db.add(Dashboard(group_id=group.id))
    await db.commit()

    return _group_response(group, 1)


@router.get("", response_model=list[GroupResponse])
async def list_groups(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[GroupResponse]:
    mem_result = await db.execute(
        select(GroupMember.group_id).where(
            GroupMember.user_id == current_user.id,
            GroupMember.left_at.is_(None),
        )
    )
    group_ids = [row[0] for row in mem_result.all()]
    if not group_ids:
        return []

    groups_result = await db.execute(select(Group).where(Group.id.in_(group_ids), Group.deleted_at.is_(None)).order_by(Group.name))
    groups = groups_result.scalars().all()

    counts_result = await db.execute(
        select(GroupMember.group_id, func.count(GroupMember.id))
        .where(GroupMember.group_id.in_(group_ids), GroupMember.left_at.is_(None))
        .group_by(GroupMember.group_id)
    )
    counts = {row[0]: row[1] for row in counts_result.all()}

    return [_group_response(g, counts.get(g.id, 0)) for g in groups]


@router.get("/{group_id}", response_model=GroupResponse)
async def get_group(
    group_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GroupResponse:
    await _get_membership(group_id, current_user, db)
    result = await db.execute(select(Group).where(Group.id == group_id, Group.deleted_at.is_(None)))
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return _group_response(group, await _get_member_count(group_id, db))


@router.patch("/{group_id}", response_model=GroupResponse)
async def update_group(
    group_id: uuid.UUID,
    body: GroupUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GroupResponse:
    membership = await _get_membership(group_id, current_user, db)
    _assert_admin(membership)

    result = await db.execute(select(Group).where(Group.id == group_id, Group.deleted_at.is_(None)))
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")

    if body.name is not None:
        group.name = body.name
    await db.commit()

    return _group_response(group, await _get_member_count(group_id, db))


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    membership = await _get_membership(group_id, current_user, db)
    _assert_owner(membership)

    result = await db.execute(select(Group).where(Group.id == group_id, Group.deleted_at.is_(None)))
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")

    group.deleted_at = datetime.now(UTC)
    await db.commit()


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


@router.get("/{group_id}/members", response_model=list[MemberResponse])
async def list_members(
    group_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MemberResponse]:
    await _get_membership(group_id, current_user, db)

    result = await db.execute(
        select(GroupMember, User)
        .join(User, GroupMember.user_id == User.id)
        .where(GroupMember.group_id == group_id, GroupMember.left_at.is_(None))
        .order_by(GroupMember.joined_at)
    )
    return [
        MemberResponse(
            user_id=m.user_id,
            display_name=u.display_name,
            email=u.email,
            role=m.role,
            dashboard_role=m.dashboard_role,
            joined_at=m.joined_at,
        )
        for m, u in result.all()
    ]


@router.delete("/{group_id}/members/me", status_code=status.HTTP_204_NO_CONTENT)
async def leave_group(
    group_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    membership = await _get_membership(group_id, current_user, db)

    if membership.role == GroupRole.owner and await _count_active_owners(group_id, db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Transfer ownership before leaving — you are the last owner",
        )

    membership.left_at = datetime.now(UTC)
    await db.commit()


@router.patch("/{group_id}/members/{user_id}", response_model=MemberResponse)
async def update_member(
    group_id: uuid.UUID,
    user_id: uuid.UUID,
    body: MemberRoleUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemberResponse:
    actor = await _get_membership(group_id, current_user, db)

    target_result = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user_id,
            GroupMember.left_at.is_(None),
        )
    )
    target = target_result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")

    if body.role is not None:
        _assert_owner(actor)
        if target.role == GroupRole.owner and body.role != GroupRole.owner and await _count_active_owners(group_id, db) <= 1:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot demote the last owner")
        target.role = GroupRole(body.role)

    if body.dashboard_role is not None:
        _assert_admin(actor)
        target.dashboard_role = DashboardRole(body.dashboard_role)

    await db.commit()

    user_result = await db.execute(select(User).where(User.id == user_id))
    user = user_result.scalar_one()

    return MemberResponse(
        user_id=target.user_id,
        display_name=user.display_name,
        email=user.email,
        role=target.role,
        dashboard_role=target.dashboard_role,
        joined_at=target.joined_at,
    )


@router.delete("/{group_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    group_id: uuid.UUID,
    user_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    actor = await _get_membership(group_id, current_user, db)
    _assert_admin(actor)

    target_result = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user_id,
            GroupMember.left_at.is_(None),
        )
    )
    target = target_result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")

    if target.role == GroupRole.owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot remove an owner")
    if target.role == GroupRole.admin and actor.role != GroupRole.owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owners can remove admins")

    target.left_at = datetime.now(UTC)
    await db.commit()


# ---------------------------------------------------------------------------
# Invites (management — creation/listing/revoke under the group)
# ---------------------------------------------------------------------------


@router.post("/{group_id}/invites", status_code=status.HTTP_201_CREATED, response_model=InviteResponse)
async def create_invite(
    group_id: uuid.UUID,
    body: InviteCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InviteResponse:
    membership = await _get_membership(group_id, current_user, db)
    _assert_admin(membership)

    now = datetime.now(UTC)
    invite = Invite(
        group_id=group_id,
        code=secrets.token_urlsafe(8),
        created_by=current_user.id,
        expires_at=now + timedelta(days=body.expires_in_days),
        max_uses=body.max_uses,
        created_at=now,
    )
    db.add(invite)
    await db.commit()

    return InviteResponse.model_validate(invite)


@router.get("/{group_id}/invites", response_model=list[InviteResponse])
async def list_invites(
    group_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[InviteResponse]:
    membership = await _get_membership(group_id, current_user, db)
    _assert_admin(membership)

    result = await db.execute(
        select(Invite)
        .where(
            Invite.group_id == group_id,
            Invite.revoked.is_(False),
            Invite.expires_at > datetime.now(UTC),
        )
        .order_by(Invite.created_at.desc())
    )
    return [InviteResponse.model_validate(inv) for inv in result.scalars().all()]


@router.patch(
    "/{group_id}/invites/{invite_id}/revoke",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_invite(
    group_id: uuid.UUID,
    invite_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    membership = await _get_membership(group_id, current_user, db)
    _assert_admin(membership)

    result = await db.execute(select(Invite).where(Invite.id == invite_id, Invite.group_id == group_id))
    invite = result.scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")

    invite.revoked = True
    await db.commit()
