"""Dashboard invite links.

Sharing hands someone a code rather than looking them up — there is no way to ask this API who
exists. Management is dashboard-scoped and needs share rights; redemption is keyed by the code.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
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
from app.services.shares import create_share, dashboard_audience_user_ids, get_resource_shares, load_dashboard_access
from app.sse.choreography import Fanout, commit_and_broadcast
from app.sse.events import build_activity_sse_dict, build_notification_sse_dict

router = APIRouter(tags=["invites"])


async def _dashboard_for_share_management(
    dashboard_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> Dashboard:
    # The canonical accessor rather than a hand-rolled query, because it filters trashed dashboards:
    # the redeem paths below reject those, so minting an invite on one yields a code nobody can use.
    dashboard, _shares, role = await load_dashboard_access(dashboard_id, user, db)
    permissions.assert_can_manage_shares(role)
    return dashboard


@router.post(
    "/dashboards/{dashboard_id}/invites",
    status_code=status.HTTP_201_CREATED,
    response_model=InviteCreatedResponse,
)
@limiter.limit(WRITE_LIMIT)
async def create_invite(
    request: Request,
    dashboard_id: uuid.UUID,
    body: InviteCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InviteCreatedResponse:
    """Mint an invite code. The raw code is returned here and nowhere else, ever again."""
    dashboard = await _dashboard_for_share_management(dashboard_id, current_user, db)
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
@limiter.limit(WRITE_LIMIT)
async def delete_invite(
    request: Request,
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

    Unauthenticated so a recipient can see what they are joining before signing up, and side-
    effect free because link scanners issue GETs that would otherwise burn the code.
    """
    invite = await load_live_invite(code, db)
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    result = await db.execute(select(Dashboard).where(Dashboard.id == invite.dashboard_id))
    dashboard = result.scalar_one_or_none()
    if dashboard is None or dashboard.deleted_at is not None:
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
    """Redeem an invite for the signed-in user, granting the role it carries.

    Both rules follow from the code being single-use: it decides before it consumes, so a no-op
    redeem leaves the code live, and it never downgrades an existing higher role.
    """
    invite = await load_live_invite(code, db)
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    result = await db.execute(select(Dashboard).where(Dashboard.id == invite.dashboard_id))
    dashboard = result.scalar_one_or_none()
    if dashboard is None or dashboard.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

    role = ShareRole(invite.role)
    existing_shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
    held = permissions.highest_role(
        [ShareRole(share.role) for share in existing_shares if share.principal_type == PrincipalType.user and share.principal_id == current_user.id]
    )

    # The owner redeeming their own link is a no-op, not an error: they already have full access,
    # and a share row for the owner would contradict "owner is the absence of a share".
    if dashboard.user_id == current_user.id or (held is not None and permissions.is_at_least(held, role)):
        # Nothing to grant, so nothing is consumed — and the response reports the access they hold,
        # not what the link offered. For the owner that is `None`, this codebase's spelling of owner.
        return InviteAcceptResponse(dashboard_id=dashboard.id, dashboard_name=dashboard.name, role=held)

    # Consume only now that redemption will change something. Still the atomic UPDATE, so a code
    # claimed by someone else between the check above and here loses here rather than double-granting.
    if await consume_invite(code, current_user.id, db) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is no longer valid")

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
    event_message = await build_activity_sse_dict(db, event)
    notification_message = await build_notification_sse_dict(db, notification)
    shares = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)

    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[
            Fanout(event_message, dashboard_audience_user_ids(dashboard, shares)),
            # The owner alone: redemption is their notification, not the whole audience's.
            Fanout(notification_message, {dashboard.user_id}),
        ],
    )

    return InviteAcceptResponse(dashboard_id=dashboard.id, dashboard_name=dashboard.name, role=role)
