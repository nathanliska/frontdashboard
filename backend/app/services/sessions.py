"""Session lifecycle — the only module that writes the `sessions` table.

A session is one login. It outlives the refresh tokens that rotate beneath it,
which is what makes it something you can revoke, name, and check.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token
from app.config import settings
from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User


async def start_session(user_id: uuid.UUID, db: AsyncSession) -> tuple[UserSession, str]:
    """Create a session and its first refresh token. Returns (session, raw_token)."""
    session = UserSession(user_id=user_id)
    db.add(session)
    await db.flush()
    raw = await issue_refresh_token(session, db, datetime.now(UTC))
    return session, raw


async def issue_refresh_token(session: UserSession, db: AsyncSession, now: datetime) -> str:
    """Mint a successor token inside an existing session. Returns the raw token."""
    raw, token_hash = create_opaque_token()
    db.add(
        RefreshToken(
            session_id=session.id,
            user_id=session.user_id,
            token_hash=token_hash,
            expires_at=now + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    session.last_used_at = now
    await db.flush()
    return raw


async def live_session(session_id: uuid.UUID, db: AsyncSession) -> UserSession | None:
    """The session, if it exists, is not revoked, and its user is not deleted."""
    result = await db.execute(
        select(UserSession)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.id == session_id,
            UserSession.revoked_at.is_(None),
            User.deleted_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def session_is_live(session_id: uuid.UUID, db: AsyncSession) -> bool:
    return await live_session(session_id, db) is not None
