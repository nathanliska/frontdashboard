from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.limiter import limiter
from app.models.group import GroupMember, GroupRole
from app.models.invite import Invite
from app.models.user import User
from app.schemas.groups import MemberResponse
from app.services.activity import EventType, log_event
from app.services.notifications import maybe_notify
from app.sse.events import build_activity_sse_dict, build_notification_sse_dicts
from app.sse.manager import manager

router = APIRouter(prefix="/api/invites", tags=["invites"])


@router.post("/{code}/join", response_model=MemberResponse)
@limiter.limit("10/minute")
async def join_group(
    request: Request,
    code: str,
    _csrf: None = Depends(require_csrf),
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
    await db.flush()
    event = log_event(
        db,
        event_type=EventType.membership_added,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="group_member",
        entity_id=membership.id,
        group_id=invite.group_id,
        payload={"user_id": str(current_user.id), "via": "invite"},
    )
    notifs = await maybe_notify(db, event)
    event_message = await build_activity_sse_dict(db, event)
    notif_messages = await build_notification_sse_dicts(db, notifs)
    await db.commit()
    await manager.broadcast(event_message, group_id=invite.group_id, actor_id=current_user.id)
    for notif, message in zip(notifs, notif_messages, strict=True):
        await manager.broadcast(message, group_id=None, actor_id=notif.user_id)

    return MemberResponse(
        user_id=current_user.id,
        display_name=current_user.display_name,
        email=current_user.email,
        role=membership.role,
        joined_at=membership.joined_at,
    )
