import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
from app.models.activity import ChangedField
from app.models.dashboard import Dashboard
from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.dashboards import (
    DashboardSummary,
)
from app.schemas.shares import DashboardMemberResponse, OwnerTransfer, ShareCreate, ShareResponse, ShareUpdate
from app.services import permissions
from app.services.accounts import lock_live_user
from app.services.activity import EventType
from app.services.dashboards import (
    build_dashboard_event_message,
    to_summary,
)
from app.services.notifications import build_notification_messages, notification_fanouts, stage_notification
from app.services.preferences import (
    remove_dashboard_from_preferences,
)
from app.services.shares import (
    create_share,
    dashboard_fanout,
    get_resource_share,
    get_resource_shares,
    load_dashboard_access,
    resolve_member_responses,
    resolve_share_responses,
    stage_dashboard_share_notification,
)
from app.sse.choreography import ClientIdHeader, commit_and_broadcast

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


def _dashboard_share_event_payload(
    dashboard: Dashboard,
    share: ResourceShare,
    action: str,
) -> dict[str, Any]:
    return {
        "dashboard_name": dashboard.name,
        "changed_fields": [ChangedField.shares],
        "share_action": action,
        "share_event_type": f"dashboard.share_{action}",
        "share_id": str(share.id),
        "principal_type": str(share.principal_type),
        "principal_id": str(share.principal_id),
        "role": str(share.role),
    }


@router.get("/{dashboard_id}/members", response_model=list[DashboardMemberResponse])
async def list_dashboard_members(
    dashboard_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DashboardMemberResponse]:
    """Everyone with access to this dashboard, owner first.

    Readable by any member, unlike `/shares`: the picker attaching people to events is an editor
    surface, and display names are already mutually visible in the activity feed.
    """
    dashboard, shares, _role = await load_dashboard_access(dashboard_id, current_user, db)
    return await resolve_member_responses(dashboard, shares, db)


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


@router.patch("/{dashboard_id}/shares/{share_id}", response_model=ShareResponse)
@limiter.limit(WRITE_LIMIT)
async def update_dashboard_share(
    request: Request,
    dashboard_id: uuid.UUID,
    share_id: uuid.UUID,
    body: ShareUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
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
    notification_messages = await build_notification_messages(
        db,
        [n] if (n := stage_dashboard_share_notification(db, dashboard=dashboard, share=share, current_user=current_user, action="updated")) else [],
    )
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="updated"),
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, current_shares), *notification_fanouts(notification_messages)],
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
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a direct share from a dashboard."""
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    share = await get_resource_share(ResourceType.dashboard, dashboard_id, share_id, db)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    notification_messages = await build_notification_messages(
        db,
        [n] if (n := stage_dashboard_share_notification(db, dashboard=dashboard, share=share, current_user=current_user, action="removed")) else [],
    )
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_removed,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="removed"),
        client_id=client_id,
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
        fanouts=[dashboard_fanout(event_message, dashboard, shares), *notification_fanouts(notification_messages)],
    )


@router.post("/{dashboard_id}/owner", response_model=DashboardSummary)
@limiter.limit(WRITE_LIMIT)
async def transfer_dashboard_ownership(
    request: Request,
    dashboard_id: uuid.UUID,
    body: OwnerTransfer,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> DashboardSummary:
    """Hand the dashboard to a member; the caller stays on as an editor.

    Owner is the absence of a share row (ADR-001), so this is three writes in one transaction:
    the creator column moves, the new owner's grant goes, and the old owner gets an editor grant.
    The new owner must already be a member — inviting and promoting in one step would put someone
    in charge who never accepted anything.
    """
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    permissions.assert_can_manage_shares(role)
    if body.user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You already own this dashboard")
    share = next((s for s in shares if s.principal_type == PrincipalType.user and s.principal_id == body.user_id), None)
    # A member deleting their account sheds this share and tombstones the row in one transaction,
    # and handing a dashboard to an account on its way out would strand it.
    if share is None or await lock_live_user(db, body.user_id) is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The new owner must already be a member of this dashboard")

    notification = stage_notification(
        db,
        user_id=body.user_id,
        type=EventType.dashboard_share_updated.value,
        title="Dashboard ownership transferred",
        body=f'{current_user.display_name} made you the owner of "{dashboard.name}".',
        reference_type="dashboard",
        reference_id=dashboard.id,
    )
    notification_messages = await build_notification_messages(db, [(body.user_id, notification)])
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_updated,
        current_user=current_user,
        dashboard=dashboard,
        payload={
            "dashboard_name": dashboard.name,
            "changed_fields": [ChangedField.shares],
            "share_action": "transferred",
            "share_event_type": EventType.dashboard_share_updated.value,
            "share_id": str(share.id),
            "principal_type": str(share.principal_type),
            "principal_id": str(share.principal_id),
            "role": EffectiveRole.owner.value,
        },
        client_id=client_id,
    )
    dashboard.user_id = body.user_id
    await db.delete(share)
    await db.flush()
    await create_share(
        ResourceType.dashboard,
        dashboard.id,
        ShareCreate(principal_type=PrincipalType.user, principal_id=current_user.id, role=EffectiveRole.editor),
        granted_by=body.user_id,
        db=db,
    )
    # Audience from before the writes: both parties are members either way.
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[dashboard_fanout(event_message, dashboard, shares), *notification_fanouts(notification_messages)],
    )
    await db.refresh(dashboard)
    return to_summary(dashboard, "Shared directly with you", True, can_edit=True, can_manage_shares=False)


@router.delete("/{dashboard_id}/membership", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def leave_dashboard(
    request: Request,
    dashboard_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    client_id: ClientIdHeader = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove the caller's own share — leave a dashboard they once accepted an invite to.

    Consent granted at redemption must stay withdrawable, or an accepted invite becomes a permanent
    claim on the member's account view. The server finds the share itself: `/shares` stays
    owner-only, and a member never learns share ids.
    """
    dashboard, shares, role = await load_dashboard_access(dashboard_id, current_user, db)
    if role is EffectiveRole.owner:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The owner cannot leave their own dashboard — delete it instead",
        )
    share = next(
        (s for s in shares if s.principal_type == PrincipalType.user and s.principal_id == current_user.id),
        None,
    )
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")

    # Same event as an owner removal, distinguished by share_action — the "joined" precedent.
    event_message = await build_dashboard_event_message(
        db,
        event_type=EventType.dashboard_share_removed,
        current_user=current_user,
        dashboard=dashboard,
        payload=_dashboard_share_event_payload(dashboard, share, action="left"),
        client_id=client_id,
    )
    current_user.preferences = remove_dashboard_from_preferences(current_user.preferences, dashboard.id)
    await db.delete(share)
    # Audience computed before the delete, so the leaver's other tabs still get the frame and
    # drop the dashboard through the ordinary share_removed handling.
    await commit_and_broadcast(db, actor_id=current_user.id, fanouts=[dashboard_fanout(event_message, dashboard, shares)])
