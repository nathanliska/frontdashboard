"""Account deletion: the row becomes a tombstone so everything that names it stays valid (FDR-001)."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ChangedField, EventType
from app.models.dashboard import Dashboard
from app.models.dashboard_invite import DashboardInvite
from app.models.email_verification_token import EmailVerificationToken
from app.models.notification import Notification
from app.models.password_reset_token import PasswordResetToken
from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.services.activity import build_event_message
from app.services.retention import purge_dashboard
from app.services.sessions import revoke_user_sessions
from app.services.shares import dashboard_fanout, get_resource_shares
from app.sse.choreography import Fanout

DELETED_DISPLAY_NAME = "Deleted user"


async def shared_dashboards_owned_by(db: AsyncSession, user: User) -> list[str]:
    """Names of the live dashboards this user owns that someone else can see."""
    result = await db.execute(
        select(Dashboard.name)
        .where(Dashboard.user_id == user.id, Dashboard.deleted_at.is_(None))
        .where(select(ResourceShare.id).where(ResourceShare.resource_id == Dashboard.id).exists())
        .order_by(Dashboard.name)
    )
    return list(result.scalars().all())


async def delete_account(db: AsyncSession, user: User) -> tuple[list[uuid.UUID], list[Fanout]]:
    """Purge what only this person could reach, leave everything shared, tombstone the row.

    Authorship and presence on other people's dashboards — items, events, assignments,
    participations — stay and render from the tombstone's name, exactly as after a leave.
    Caller checks `shared_dashboards_owned_by` first and owns the commit; returns the revoked
    session ids to drop after it and the "left" frames for each dashboard's remaining members.
    """
    memberships = (
        await db.execute(
            select(ResourceShare, Dashboard)
            .join(Dashboard, Dashboard.id == ResourceShare.resource_id)
            .where(ResourceShare.principal_type == PrincipalType.user, ResourceShare.principal_id == user.id)
            # A trashed dashboard has no one to tell, as a leave would have found nothing there.
            .where(Dashboard.deleted_at.is_(None))
        )
    ).all()
    # Built before the rewrite, so the frame carries the name people knew, not the tombstone's.
    fanouts: list[Fanout] = []
    for share, dashboard in memberships:
        audience = await get_resource_shares(ResourceType.dashboard, dashboard.id, db)
        message = await build_event_message(
            db,
            event_type=EventType.dashboard_share_removed,
            current_user=user,
            dashboard=dashboard,
            entity_type="dashboard",
            entity_id=dashboard.id,
            payload={
                "dashboard_name": dashboard.name,
                "changed_fields": [ChangedField.shares],
                "share_action": "left",
                "share_event_type": EventType.dashboard_share_removed.value,
                "share_id": str(share.id),
                "principal_type": str(share.principal_type),
                "principal_id": str(share.principal_id),
                "role": EffectiveRole(share.role).value,
            },
        )
        fanouts.append(dashboard_fanout(message, dashboard, audience))

    owned = (await db.execute(select(Dashboard).where(Dashboard.user_id == user.id))).scalars().all()
    for dashboard in owned:
        await purge_dashboard(db, dashboard)
    await db.execute(delete(ResourceShare).where(ResourceShare.principal_id == user.id))
    await db.execute(delete(DashboardInvite).where(DashboardInvite.created_by == user.id))
    await db.execute(delete(Notification).where(Notification.user_id == user.id))
    await db.execute(delete(EmailVerificationToken).where(EmailVerificationToken.user_id == user.id))
    await db.execute(delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id))
    revoked = await revoke_user_sessions(user.id, db)

    # `.invalid` is reserved and never resolves; the id keeps it unique so the address is free again.
    user.email = f"{user.id}@deleted.invalid"
    user.password_hash = "!"
    user.display_name = DELETED_DISPLAY_NAME
    user.preferences = {}
    user.deleted_at = datetime.now(UTC)
    return revoked, fanouts
