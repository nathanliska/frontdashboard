"""Dashboard invite links.

Sharing works by handing someone a code rather than looking them up in a user directory —
there is no way to ask this API who exists. Owner-side management (create/list/revoke) is
dashboard-scoped and needs share-management rights; redemption is keyed by the code itself.

Lives outside routers/dashboards.py deliberately: that module is already oversized (#39), and
this feature composes public services rather than needing its private helpers.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.limiter import limiter
from app.models.activity import EventType
from app.models.dashboard import Dashboard
from app.models.share import PrincipalType, ResourceType, ShareRole
from app.models.user import User
from app.schemas.invites import (
    InviteAcceptResponse,
    InviteCreate,
    InviteCreatedResponse,
    InvitePreviewResponse,
    InviteResponse,
)
from app.schemas.shares import ShareCreate
from app.services import permissions
from app.services.activity import log_event
from app.services.invites import (
    consume_invite,
    issue_invite,
    list_live_invites,
    load_live_invite,
    revoke_invite,
)
from app.services.notifications import stage_notification
from app.services.shares import create_share, get_resource_shares, load_resource_access
from app.sse.events import build_activity_sse_dict, build_notification_sse_dict
from app.sse.manager import manager

router = APIRouter(tags=["invites"])


async def _dashboard_for_share_management(
    dashboard_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> Dashboard:
    result = await db.execute(select(Dashboard).where(Dashboard.id == dashboard_id))
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    _, role = await load_resource_access(ResourceType.dashboard, dashboard.id, dashboard.user_id, user, db)
    permissions.assert_can_manage_shares(role)
    return dashboard


@router.post(
    "/dashboards/{dashboard_id}/invites",
    status_code=status.HTTP_201_CREATED,
    response_model=InviteCreatedResponse,
)
async def create_invite(
    dashboard_id: uuid.UUID,
    body: InviteCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InviteCreatedResponse:
    """Mint an invite code. The raw code is returned here and nowhere else, ever again."""
    dashboard = await _dashboard_for_share_management(dashboard_id, current_user, db)
    if dashboard.archived:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Dashboard is archived")

    code, invite = await issue_invite(dashboard.id, body.role, current_user.id, db)
    await db.commit()
    return InviteCreatedResponse(
        id=invite.id,
        role=ShareRole(invite.role),
        expires_at=invite.expires_at,
        created_at=invite.created_at,
        code=code,
    )


@router.get("/dashboards/{dashboard_id}/invites", response_model=list[InviteResponse])
async def list_invites(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[InviteResponse]:
    """List invites that can still be redeemed. Codes are not included — they are unrecoverable."""
    dashboard = await _dashboard_for_share_management(dashboard_id, current_user, db)
    invites = await list_live_invites(dashboard.id, db)
    return [InviteResponse.model_validate(invite) for invite in invites]


@router.delete("/dashboards/{dashboard_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invite(
    dashboard_id: uuid.UUID,
    invite_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Revoke an unredeemed invite."""
    dashboard = await _dashboard_for_share_management(dashboard_id, current_user, db)
    if not await revoke_invite(invite_id, dashboard.id, db):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    await db.commit()


@router.get("/invites/{code}", response_model=InvitePreviewResponse)
@limiter.limit("20/minute")
async def preview_invite(
    request: Request,
    code: str,
    db: AsyncSession = Depends(get_db),
) -> InvitePreviewResponse:
    """Describe an invite without consuming it.

    Unauthenticated on purpose: the recipient has to see what they are joining before deciding
    to sign up. Side-effect free on purpose too — link scanners and message previews issue GETs,
    and a GET that redeemed the invite would burn it before a human ever clicked.
    """
    invite = await load_live_invite(code, db)
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    result = await db.execute(select(Dashboard).where(Dashboard.id == invite.dashboard_id))
    dashboard = result.scalar_one_or_none()
    if dashboard is None or dashboard.archived:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    inviter = await db.get(User, invite.created_by)
    return InvitePreviewResponse(
        dashboard_name=dashboard.name,
        invited_by=inviter.display_name if inviter else "Someone",
        role=ShareRole(invite.role),
    )


@router.post("/invites/{code}/accept", response_model=InviteAcceptResponse)
@limiter.limit("10/minute")
async def accept_invite(
    request: Request,
    code: str,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InviteAcceptResponse:
    """Redeem an invite for the signed-in user, granting the role it carries."""
    invite = await consume_invite(code, current_user.id, db)
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    result = await db.execute(select(Dashboard).where(Dashboard.id == invite.dashboard_id))
    dashboard = result.scalar_one_or_none()
    if dashboard is None or dashboard.archived:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    role = ShareRole(invite.role)
    # The owner redeeming their own link is a no-op, not an error: they already have full access,
    # and a share row for the owner would contradict "owner is the absence of a share".
    if dashboard.user_id != current_user.id:
        await create_share(
            ResourceType.dashboard,
            dashboard.id,
            ShareCreate(principal_type=PrincipalType.user, principal_id=current_user.id, role=role),
            invite.created_by,
            db,
        )

        notification = stage_notification(
            db,
            user_id=dashboard.user_id,
            type=EventType.dashboard_share_added.value,
            title="Someone joined a dashboard",
            body=f"{current_user.display_name} accepted an invite to {dashboard.name}.",
            reference_type="dashboard",
            reference_id=dashboard.id,
        )
        event = log_event(
            db,
            event_type=EventType.dashboard_share_added,
            actor_id=current_user.id,
            actor_display_name=current_user.display_name,
            entity_type="dashboard",
            entity_id=dashboard.id,
            entity_version=dashboard.version,
            payload={"dashboard_id": str(dashboard.id), "changed_fields": ["shares"]},
        )
        # Built before the commit, broadcast after — the ordering the rest of the app relies on.
        event_message = await build_activity_sse_dict(db, event)
        notification_message = await build_notification_sse_dict(db, notification)
        shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
        await db.commit()

        recipients = {dashboard.user_id} | {share.principal_id for share in shares}
        await manager.broadcast(event_message, user_ids=recipients, actor_id=current_user.id)
        await manager.broadcast(notification_message, user_ids={dashboard.user_id}, actor_id=current_user.id)
    else:
        await db.commit()

    return InviteAcceptResponse(dashboard_id=dashboard.id, dashboard_name=dashboard.name, role=role)
