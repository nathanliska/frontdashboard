"""Dashboard invite codes — issue, preview, consume, revoke.

An invite is a bearer credential: whoever holds the raw code can redeem it. Only its sha256 is
stored, it is single use, it expires, and the issuer can revoke it. Callers own the commit,
matching the rest of the mutation choreography (see backend/CLAUDE.md).
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token, hash_token
from app.config import settings
from app.models.dashboard_invite import DashboardInvite
from app.models.share import ShareRole


def _is_live(now: datetime) -> Any:
    """Not yet redeemed, not revoked, not expired."""
    return and_(
        DashboardInvite.used_at.is_(None),
        DashboardInvite.revoked_at.is_(None),
        DashboardInvite.expires_at > now,
    )


async def issue_invite(
    dashboard_id: uuid.UUID,
    role: ShareRole,
    created_by: uuid.UUID,
    db: AsyncSession,
) -> tuple[str, DashboardInvite]:
    """Create an invite and return (raw_code, row). The raw code is never recoverable after this."""
    raw_code, code_hash = create_opaque_token()
    invite = DashboardInvite(
        dashboard_id=dashboard_id,
        code_hash=code_hash,
        role=role,
        created_by=created_by,
        expires_at=datetime.now(UTC) + timedelta(hours=settings.dashboard_invite_expire_hours),
    )
    db.add(invite)
    await db.flush()
    return raw_code, invite


async def load_live_invite(code: str, db: AsyncSession) -> DashboardInvite | None:
    """Look up a redeemable invite by raw code. Read-only — safe for the preview GET."""
    result = await db.execute(
        select(DashboardInvite).where(
            DashboardInvite.code_hash == hash_token(code),
            _is_live(datetime.now(UTC)),
        )
    )
    return result.scalar_one_or_none()


async def consume_invite(code: str, redeemed_by: uuid.UUID, db: AsyncSession) -> DashboardInvite | None:
    """Atomically mark an invite redeemed. Returns None if it was already taken, revoked or expired.

    The liveness check lives in the UPDATE's WHERE clause rather than a preceding SELECT, so two
    simultaneous redemptions of the same code can't both succeed — the loser matches zero rows.
    """
    now = datetime.now(UTC)
    result = cast(
        "CursorResult[Any]",
        await db.execute(
            update(DashboardInvite)
            .where(DashboardInvite.code_hash == hash_token(code), _is_live(now))
            .values(used_at=now, redeemed_by=redeemed_by)
            .returning(DashboardInvite.id)
        ),
    )
    row = result.first()
    if row is None:
        return None

    invite = await db.get(DashboardInvite, row[0])
    return invite


async def list_live_invites(dashboard_id: uuid.UUID, db: AsyncSession) -> list[DashboardInvite]:
    result = await db.execute(
        select(DashboardInvite)
        .where(DashboardInvite.dashboard_id == dashboard_id, _is_live(datetime.now(UTC)))
        .order_by(DashboardInvite.created_at.desc())
    )
    return list(result.scalars().all())


async def revoke_invite(invite_id: uuid.UUID, dashboard_id: uuid.UUID, db: AsyncSession) -> bool:
    """Revoke a live invite. Returns False when it doesn't exist, or was already spent/revoked."""
    now = datetime.now(UTC)
    result = cast(
        "CursorResult[Any]",
        await db.execute(
            update(DashboardInvite)
            .where(
                DashboardInvite.id == invite_id,
                # Scoped to the dashboard from the path, so a valid invite id can't be revoked
                # through a dashboard the caller happens to administer.
                DashboardInvite.dashboard_id == dashboard_id,
                DashboardInvite.used_at.is_(None),
                DashboardInvite.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        ),
    )
    return result.rowcount > 0
