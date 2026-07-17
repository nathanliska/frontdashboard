"""Session lifecycle — the only module that writes the `sessions` table.

A session is one login. It outlives the refresh tokens that rotate beneath it,
which is what makes it something you can revoke, name, and check.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token, hash_token
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


_GRACE_WINDOW = timedelta(seconds=10)


class RefreshRejected(Exception):
    """The refresh token cannot be rotated. The router turns this into a 401."""


async def revoke_session(session_id: uuid.UUID, db: AsyncSession) -> None:
    """Kill a session. The only way a session dies — every trigger routes here.

    Individual tokens are left alone: every path that consumes one joins `sessions`
    and rejects a revoked one, so the session flag alone is sufficient.
    """
    await db.execute(update(UserSession).where(UserSession.id == session_id, UserSession.revoked_at.is_(None)).values(revoked_at=datetime.now(UTC)))


async def rotate_refresh_token(raw_token: str, db: AsyncSession) -> tuple[UserSession, str]:
    """Consume a refresh token and mint its successor.

    The database picks the winner, not the application: an application-level
    read-then-write lets two concurrent requests both observe a valid token and
    both mint a successor, which is exactly finding #6.
    """
    now = datetime.now(UTC)
    token_hash = hash_token(raw_token)

    consumed = await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > now,
        )
        .values(revoked_at=now)
        .returning(RefreshToken.session_id)
    )
    winning_session_id = consumed.scalar_one_or_none()

    if winning_session_id is not None:
        session = await live_session(winning_session_id, db)
        if session is None:
            raise RefreshRejected
        return session, await issue_refresh_token(session, db, now)

    # We lost, or the token was never usable. Work out which — the order below is
    # load-bearing.
    existing = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    token = existing.scalar_one_or_none()
    if token is None:
        raise RefreshRejected

    # Expiry BEFORE reuse: an expired-and-previously-rotated token matches both, and
    # it must read as expiry. Revoking the session of someone who was away for a week
    # would be noise, not security.
    if token.expires_at <= now:
        raise RefreshRejected

    session = await live_session(token.session_id, db)
    if session is None:
        raise RefreshRejected

    if token.revoked_at is None:
        # Not expired, not revoked, yet the UPDATE matched nothing. Should be
        # unreachable; refuse rather than guess.
        raise RefreshRejected

    if now - token.revoked_at <= _GRACE_WINDOW:
        # The tab stampede. Each racing tab gets its OWN successor (we store hashes
        # and cannot reissue the same raw token); both are valid, both belong to this
        # session, and the cookie jar keeps whichever lands last.
        return session, await issue_refresh_token(session, db, now)

    # Held and replayed long after it was spent: the theft shape.
    await revoke_session(token.session_id, db)
    raise RefreshRejected
