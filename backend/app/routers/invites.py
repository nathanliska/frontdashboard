from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.limiter import limiter
from app.models.group import GroupMember, GroupRole
from app.models.invite import Invite
from app.models.user import User
from app.schemas.groups import MemberResponse

router = APIRouter(prefix="/api/invites", tags=["invites"])


@router.post("/{code}/join", response_model=MemberResponse)
@limiter.limit("10/minute")
async def join_group(
    request: Request,
    code: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemberResponse:
    now = datetime.now(UTC)
    invite_result = await db.execute(
        select(Invite).where(
            Invite.code == code,
            Invite.revoked.is_(False),
            Invite.expires_at > now,
        )
    )
    invite = invite_result.scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found or expired")

    if invite.use_count >= invite.max_uses:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Invite has reached its maximum uses")

    # Already a member?
    existing_result = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == invite.group_id,
            GroupMember.user_id == current_user.id,
            GroupMember.left_at.is_(None),
        )
    )
    if existing_result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already a member of this group")

    membership = GroupMember(
        group_id=invite.group_id,
        user_id=current_user.id,
        role=GroupRole.member,
        joined_at=now,
    )
    db.add(membership)
    invite.use_count += 1
    await db.commit()

    return MemberResponse(
        user_id=current_user.id,
        display_name=current_user.display_name,
        email=current_user.email,
        role=membership.role,
        dashboard_role=membership.dashboard_role,
        joined_at=membership.joined_at,
    )
