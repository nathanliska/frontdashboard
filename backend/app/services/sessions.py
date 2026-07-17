"""Session lifecycle — the only module that writes the `sessions` table.

A session is one login. It outlives the refresh tokens that rotate beneath it,
which is what makes it something you can revoke, name, and check.
"""

import uuid
from collections.abc import Iterable
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


async def live_session(session_id: uuid.UUID, db: AsyncSession) -> tuple[UserSession, User] | None:
    """The session and its user, if the session exists, is not revoked, and its user
    is not deleted.

    Returns both because every caller that validates a session also needs the user
    (to mint the next access token) — resolving them together is the same join either
    way and spares the caller a redundant `users` lookup.
    """
    result = await db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.id == session_id,
            UserSession.revoked_at.is_(None),
            User.deleted_at.is_(None),
        )
    )
    row = result.one_or_none()
    return (row[0], row[1]) if row is not None else None


async def session_is_live(session_id: uuid.UUID, db: AsyncSession) -> bool:
    return await live_session(session_id, db) is not None


_GRACE_WINDOW = timedelta(seconds=10)


class RefreshRejected(Exception):
    """The refresh token cannot be rotated. The router turns this into a 401.

    Carries the session id when the rejection revoked one (the theft path), so the
    router can drop that session's streams AFTER it commits the revocation.
    """

    def __init__(self, revoked_session_id: uuid.UUID | None = None) -> None:
        self.revoked_session_id = revoked_session_id
        super().__init__()


async def revoke_session(session_id: uuid.UUID, db: AsyncSession) -> uuid.UUID | None:
    """Kill a session. The only way a single session dies — every trigger routes here.

    Individual tokens are left alone: every path that consumes one joins `sessions`
    and rejects a revoked one, so the session flag alone is sufficient. Returns the
    revoked id (or None if it was already revoked / absent) so the caller can drop
    its streams once the write commits.
    """
    result = await db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
        .returning(UserSession.id)
    )
    return result.scalar_one_or_none()


def drop_session_streams(session_ids: Iterable[uuid.UUID]) -> None:
    """Drop live SSE streams for revoked sessions.

    Latency optimisation only — stream_events revalidates on a deadline regardless,
    so a missed drop costs up to 30s of staleness, not correctness. Call this AFTER
    the revocation commits: a stream torn down before the write is durable would only
    reconnect, revalidate against a still-live session, and resume.
    """
    from app.sse.manager import manager

    for session_id in session_ids:
        manager.disconnect_session(session_id)


async def revoke_user_sessions(
    user_id: uuid.UUID,
    db: AsyncSession,
    *,
    except_session_id: uuid.UUID | None = None,
) -> list[uuid.UUID]:
    """Revoke every live session for a user, optionally sparing one. Returns the
    revoked ids for the caller to drop post-commit.

    `except_session_id` is what lets a password change sign out your other devices
    without signing out the tab you changed it in.
    """
    query = update(UserSession).where(
        UserSession.user_id == user_id,
        UserSession.revoked_at.is_(None),
    )
    if except_session_id is not None:
        query = query.where(UserSession.id != except_session_id)
    result = await db.execute(query.values(revoked_at=datetime.now(UTC)).returning(UserSession.id))
    return list(result.scalars().all())


async def rotate_refresh_token(raw_token: str, db: AsyncSession) -> tuple[UserSession, User, str]:
    """Consume a refresh token and mint its successor. Returns (session, user, raw).

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
        live = await live_session(winning_session_id, db)
        if live is None:
            raise RefreshRejected
        session, user = live
        return session, user, await issue_refresh_token(session, db, now)

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

    live = await live_session(token.session_id, db)
    if live is None:
        raise RefreshRejected
    session, user = live

    if token.revoked_at is None:
        # Not expired, not revoked, yet the UPDATE matched nothing. Should be
        # unreachable; refuse rather than guess.
        raise RefreshRejected

    if now - token.revoked_at <= _GRACE_WINDOW:
        # The tab stampede. Each racing tab gets its OWN successor (we store hashes
        # and cannot reissue the same raw token); both are valid, both belong to this
        # session, and the cookie jar keeps whichever lands last.
        return session, user, await issue_refresh_token(session, db, now)

    # Held and replayed long after it was spent: the theft shape.
    revoked_id = await revoke_session(token.session_id, db)
    raise RefreshRejected(revoked_session_id=revoked_id)
