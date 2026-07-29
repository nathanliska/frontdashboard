"""Session lifecycle — the only module that writes the `sessions` table.

A session is one login, and since 2026-07-28 it is the *entire* credential (ADR-003): the
`session` cookie carries a 256-bit opaque token whose SHA-256 is the row. There is no access
token and no refresh token to reconcile against it, so there is no rotation, no grace window and
no reuse detection here — that machinery existed to make a *second* credential safe, and the
second credential is gone.
"""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token, hash_token
from app.config import settings
from app.models.session import UserSession
from app.models.user import User

# How stale `last_used_at` may get before a read pays for a write. The idle window is measured in
# days, so a minute of imprecision is irrelevant — what matters is that a user who only ever reads
# still slides their own idle clock, without every GET costing an UPDATE.
_IDLE_BUMP_INTERVAL = timedelta(minutes=1)


def _live(now: datetime) -> tuple[ColumnElement[bool], ...]:
    """The one definition of "this session can still authenticate".

    Splatted into every query that resolves or checks a session, so the request path and the SSE
    revalidation path cannot drift into disagreeing about what "live" means — which they would,
    since the absolute bound was added long after the first of them was written.
    """
    return (
        UserSession.revoked_at.is_(None),
        UserSession.expires_at > now,
        UserSession.last_used_at > now - timedelta(days=settings.session_idle_days),
    )


async def start_session(user_id: uuid.UUID, db: AsyncSession) -> tuple[UserSession, str]:
    """Create a session. Returns (session, raw_token).

    The raw token is never stored and never recoverable, so the caller must put it in the cookie
    now or lose it.
    """
    raw, token_hash = create_opaque_token()
    now = datetime.now(UTC)
    session = UserSession(
        user_id=user_id,
        token_hash=token_hash,
        last_used_at=now,
        expires_at=now + timedelta(days=settings.session_absolute_days),
    )
    db.add(session)
    await db.flush()
    return session, raw


async def resolve_session(raw_token: str, db: AsyncSession) -> tuple[UserSession, User] | None:
    """Turn a raw session cookie into its caller. Pure read — no writes, no commit.

    Returns both session and user because every caller needs both, and resolving them together is
    the same join either way. Sliding the idle clock is deliberately *not* done here: it needs a
    commit, and a function named "resolve" that commits is a trap for the next caller. See
    `slide_idle_clock`.
    """
    now = datetime.now(UTC)
    result = await db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.token_hash == hash_token(raw_token),
            *_live(now),
            User.deleted_at.is_(None),
        )
    )
    row = result.one_or_none()
    return None if row is None else (row[0], row[1])


async def slide_idle_clock(session: UserSession, db: AsyncSession) -> bool:
    """Advance `last_used_at`, at most once per `_IDLE_BUMP_INTERVAL`. Returns whether it wrote.

    **The caller must commit**, and only the auth dependency does — a GET never commits otherwise,
    so a read-only user would idle out mid-use. Kept out of `resolve_session` so that commit sits
    at the one call site where it is provably safe rather than hidden inside a lookup.
    """
    now = datetime.now(UTC)
    if now - session.last_used_at < _IDLE_BUMP_INTERVAL:
        return False
    await db.execute(update(UserSession).where(UserSession.id == session.id).values(last_used_at=now))
    session.last_used_at = now
    return True


async def session_is_live(session_id: uuid.UUID, db: AsyncSession) -> bool:
    """Is this session still usable? The SSE revalidation check.

    Deliberately does *not* slide the idle clock: holding a stream open is not user activity, and
    a tab left open on a forgotten laptop must not keep a session alive forever.
    """
    result = await db.execute(
        select(UserSession.id)
        .join(User, User.id == UserSession.user_id)
        .where(UserSession.id == session_id, *_live(datetime.now(UTC)), User.deleted_at.is_(None))
    )
    return result.scalar_one_or_none() is not None


async def revoke_session(session_id: uuid.UUID, db: AsyncSession) -> uuid.UUID | None:
    """Kill a session. The only way a single session dies — every trigger routes here.

    Returns the revoked id (or None if it was already revoked / absent) so the caller can drop
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

    Latency optimisation only — stream_events revalidates on a deadline regardless, so a missed
    drop costs up to 30s of staleness, not correctness. Call this AFTER the revocation commits: a
    stream torn down before the write is durable would only reconnect, revalidate against a
    still-live session, and resume.
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
    """Revoke every live session for a user, optionally sparing one. Returns the revoked ids for
    the caller to drop post-commit.

    `except_session_id` is what lets a password change sign out your other devices without
    signing out the tab you changed it in.
    """
    query = update(UserSession).where(
        UserSession.user_id == user_id,
        UserSession.revoked_at.is_(None),
    )
    if except_session_id is not None:
        query = query.where(UserSession.id != except_session_id)
    result = await db.execute(query.values(revoked_at=datetime.now(UTC)).returning(UserSession.id))
    return list(result.scalars().all())
