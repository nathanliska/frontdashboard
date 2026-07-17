import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User
from app.services import sessions
from app.services.sessions import (
    RefreshRejected,
    rotate_refresh_token,
    start_session,
)


async def _make_user(db: AsyncSession) -> User:
    user = User(
        email=f"session-{uuid.uuid4()}@example.com",
        password_hash="x",
        display_name="Session Test",
        email_verified_at=datetime.now(UTC),
    )
    db.add(user)
    await db.flush()
    return user


async def test_session_row_holds_a_refresh_token(db_session: AsyncSession) -> None:
    user = await _make_user(db_session)
    session = UserSession(user_id=user.id)
    db_session.add(session)
    await db_session.flush()

    db_session.add(
        RefreshToken(
            session_id=session.id,
            user_id=user.id,
            token_hash="hash-1",
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
    )
    await db_session.flush()

    stored = (await db_session.execute(select(RefreshToken).where(RefreshToken.session_id == session.id))).scalar_one()
    assert stored.revoked_at is None
    assert session.revoked_at is None
    assert session.last_used_at is None


async def test_deleting_a_session_cascades_to_its_tokens(db_session: AsyncSession) -> None:
    user = await _make_user(db_session)
    session = UserSession(user_id=user.id)
    db_session.add(session)
    await db_session.flush()
    db_session.add(
        RefreshToken(
            session_id=session.id,
            user_id=user.id,
            token_hash="hash-2",
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
    )
    await db_session.flush()

    await db_session.delete(session)
    await db_session.flush()

    remaining = (await db_session.execute(select(RefreshToken).where(RefreshToken.user_id == user.id))).scalars().all()
    assert remaining == []


async def _rotate_and_commit(raw: str, db: AsyncSession) -> tuple[UserSession, str]:
    """Mirrors the router: each request commits right after its own rotate call,
    on both the success and the rejection path, not batched with another
    request's commit.

    This matters because the atomic UPDATE takes a real row lock in an
    uncommitted transaction. Two racing requests each hold their own DB
    session/connection, and each commits independently as soon as its own work
    is done — exactly like two concurrent HTTP requests would. Batching both
    commits until after both coroutines finish (i.e. committing neither until
    gather() returns) would deadlock: the loser's UPDATE blocks on the winner's
    row lock, and that lock is only released by a commit that — under batching —
    never runs until the wait it's blocking on is over.

    The rejection path commits too, because a reuse-triggered revocation must
    persist — the router does the same.
    """
    try:
        result = await rotate_refresh_token(raw, db)
    except RefreshRejected:
        await db.commit()
        raise
    await db.commit()
    return result


async def test_the_database_picks_exactly_one_winner(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Atomicity, isolated from the grace window that hides it.

    The stampede test below cannot see this property. Under a read-then-write
    consume both racers observe an unrevoked token, both take the winner path,
    and the grace window lets both mint a successor anyway — which is precisely
    the outcome a correct atomic consume produces. Identical outcome, so that
    test passes against finding #6's bug.

    Close the window and the property stands on its own: whatever the racers do,
    exactly one of them may consume the token. The window is set negative rather
    than zero because both racers capture `now` within microseconds of each
    other, so a zero window would coin-flip on clock jitter.
    """
    first, second, user_id = concurrent_sessions
    monkeypatch.setattr(sessions, "_GRACE_WINDOW", timedelta(seconds=-1))

    _session, raw = await start_session(user_id, first)
    await first.commit()

    results = await asyncio.gather(
        _rotate_and_commit(raw, first),
        _rotate_and_commit(raw, second),
        return_exceptions=True,
    )

    winners = [r for r in results if not isinstance(r, Exception)]
    rejected = [r for r in results if isinstance(r, RefreshRejected)]
    assert len(winners) == 1, f"exactly one racer may consume the token, got {results}"
    assert len(rejected) == 1, f"the losing racer must be rejected, got {results}"


async def test_two_tabs_racing_refresh_both_succeed_in_one_session(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    """Tabs share one access-token cookie, so they expire together and refresh together.
    This race is the normal case, not an edge case: both must survive it."""
    first, second, user_id = concurrent_sessions

    session, raw = await start_session(user_id, first)
    await first.commit()
    session_id = session.id

    results = await asyncio.gather(
        _rotate_and_commit(raw, first),
        _rotate_and_commit(raw, second),
        return_exceptions=True,
    )

    survivors = [r for r in results if not isinstance(r, BaseException)]
    assert len(survivors) == len(results), results
    assert {r[0].id for r in survivors} == {session_id}

    live = (await first.execute(select(UserSession).where(UserSession.id == session_id, UserSession.revoked_at.is_(None)))).scalar_one_or_none()
    assert live is not None, "the stampede must not be mistaken for theft"


async def test_replay_after_the_grace_window_revokes_the_session(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    first, _second, user_id = concurrent_sessions

    session, raw = await start_session(user_id, first)
    await first.commit()

    await rotate_refresh_token(raw, first)
    await first.commit()

    # Backdate the consume past the window rather than sleeping 10s in a test.
    await first.execute(
        update(RefreshToken).where(RefreshToken.token_hash == hash_token(raw)).values(revoked_at=datetime.now(UTC) - timedelta(seconds=30))
    )
    await first.commit()

    with pytest.raises(RefreshRejected):
        await rotate_refresh_token(raw, first)
    await first.commit()

    revoked = (await first.execute(select(UserSession).where(UserSession.id == session.id))).scalar_one()
    assert revoked.revoked_at is not None


async def test_an_expired_token_is_expiry_not_theft(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    """Someone who closed their laptop for a week must not have their session
    revoked for it — expiry and replay look alike and must not be confused."""
    first, _second, user_id = concurrent_sessions

    session, raw = await start_session(user_id, first)
    await first.execute(
        update(RefreshToken).where(RefreshToken.token_hash == hash_token(raw)).values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    await first.commit()

    with pytest.raises(RefreshRejected):
        await rotate_refresh_token(raw, first)
    await first.commit()

    session_row = (await first.execute(select(UserSession).where(UserSession.id == session.id))).scalar_one()
    assert session_row.revoked_at is None, "ordinary expiry must not revoke the session"
