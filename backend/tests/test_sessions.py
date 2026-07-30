"""Session lifecycle (ADR-003).

The session cookie is the whole credential, so this file is where "can this token still act?" is
pinned. Everything asserts through `resolve_session`/`session_is_live` rather than by inspecting
rows, because those two functions are what every request actually calls.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import UserSession
from app.services import sessions
from app.services.sessions import (
    resolve_session,
    revoke_session,
    revoke_user_sessions,
    session_is_live,
    slide_idle_clock,
    start_session,
)
from tests.helpers import make_db_user


async def test_a_fresh_session_resolves_to_its_user(db_session: AsyncSession) -> None:
    user = await make_db_user(db_session)
    session, raw = await start_session(user.id, db_session)

    resolved = await resolve_session(raw, db_session)

    assert resolved is not None
    assert resolved[0].id == session.id
    assert resolved[1].id == user.id


async def test_the_raw_token_is_never_stored(db_session: AsyncSession) -> None:
    """A database disclosure must not hand over usable session cookies."""
    user = await make_db_user(db_session)
    session, raw = await start_session(user.id, db_session)

    assert session.token_hash != raw
    assert raw not in session.token_hash


async def test_an_unknown_token_resolves_to_nothing(db_session: AsyncSession) -> None:
    user = await make_db_user(db_session)
    await start_session(user.id, db_session)

    assert await resolve_session("not-a-real-token", db_session) is None


async def test_a_revoked_session_stops_resolving(db_session: AsyncSession) -> None:
    """Revocation takes effect on the very next request.

    The property the stateful design exists for, and what made short-lived access tokens
    redundant.
    """
    user = await make_db_user(db_session)
    session, raw = await start_session(user.id, db_session)

    await revoke_session(session.id, db_session)

    assert await resolve_session(raw, db_session) is None
    assert await session_is_live(session.id, db_session) is False


async def test_a_session_past_its_absolute_expiry_stops_resolving(db_session: AsyncSession) -> None:
    """Without the absolute bound, an actively used session would slide forever."""
    user = await make_db_user(db_session)
    session, raw = await start_session(user.id, db_session)
    session_id = session.id  # captured before expire_all() below expires `session` too

    await db_session.execute(
        update(UserSession)
        .where(UserSession.id == session_id)
        # Recently used, so only the absolute clock can reject this.
        .values(expires_at=datetime.now(UTC) - timedelta(seconds=1), last_used_at=datetime.now(UTC))
    )
    db_session.expire_all()

    assert await resolve_session(raw, db_session) is None
    assert await session_is_live(session_id, db_session) is False


async def test_a_session_idle_past_the_window_stops_resolving(db_session: AsyncSession) -> None:
    user = await make_db_user(db_session)
    session, raw = await start_session(user.id, db_session)
    session_id = session.id  # captured before expire_all() below expires `session` too

    await db_session.execute(
        update(UserSession)
        .where(UserSession.id == session_id)
        .values(last_used_at=datetime.now(UTC) - timedelta(days=settings.session_idle_days, seconds=1))
    )
    db_session.expire_all()

    assert await resolve_session(raw, db_session) is None
    assert await session_is_live(session_id, db_session) is False


async def test_a_soft_deleted_user_stops_resolving(db_session: AsyncSession) -> None:
    user = await make_db_user(db_session)
    _session, raw = await start_session(user.id, db_session)

    user.deleted_at = datetime.now(UTC)
    await db_session.flush()

    assert await resolve_session(raw, db_session) is None


async def test_using_a_session_slides_its_idle_clock(db_session: AsyncSession) -> None:
    """A read-only user must keep their own session alive.

    `test_any_request_slides_the_session_idle_clock` covers the same property end to end, through
    the dependency that commits it.
    """
    user = await make_db_user(db_session)
    session, _raw = await start_session(user.id, db_session)
    session_id = session.id

    stale = datetime.now(UTC) - timedelta(days=1)
    await db_session.execute(update(UserSession).where(UserSession.id == session_id).values(last_used_at=stale))
    await db_session.refresh(session)

    assert await slide_idle_clock(session, db_session) is True

    stored = (await db_session.execute(select(UserSession.last_used_at).where(UserSession.id == session_id))).scalar_one()
    assert stored > stale


async def test_the_idle_clock_is_not_rewritten_on_every_request(db_session: AsyncSession) -> None:
    """The idle-clock throttle.

    Without it every GET costs an UPDATE, which is why sliding expiry is usually skipped
    entirely. Assert the write does *not* happen, or the throttle can rot away unnoticed.
    """
    user = await make_db_user(db_session)
    session, _raw = await start_session(user.id, db_session)
    session_id = session.id
    before = (await db_session.execute(select(UserSession.last_used_at).where(UserSession.id == session_id))).scalar_one()

    assert await slide_idle_clock(session, db_session) is False

    after = (await db_session.execute(select(UserSession.last_used_at).where(UserSession.id == session_id))).scalar_one()
    assert after == before, "a session used seconds ago must not be re-written"


async def test_an_open_stream_does_not_keep_a_session_alive(db_session: AsyncSession) -> None:
    """Revalidating a stream must not renew the session.

    `session_is_live` is the SSE check; if it slid the idle clock, a tab left open on a forgotten
    laptop would renew forever. Sliding is `slide_idle_clock`'s job, called only by the auth
    dependency.
    """
    user = await make_db_user(db_session)
    session, _raw = await start_session(user.id, db_session)
    session_id = session.id  # captured before expire_all() below expires `session` too

    stale = datetime.now(UTC) - timedelta(days=1)
    await db_session.execute(update(UserSession).where(UserSession.id == session_id).values(last_used_at=stale))
    db_session.expire_all()

    assert await session_is_live(session_id, db_session) is True
    assert await resolve_session(_raw, db_session) is not None

    db_session.expire_all()
    stored = (await db_session.execute(select(UserSession.last_used_at).where(UserSession.id == session_id))).scalar_one()
    assert stored == stale


async def test_revoking_other_sessions_spares_the_caller(db_session: AsyncSession) -> None:
    """Revoking other sessions spares the caller's own.

    What lets a password change sign out your other devices without signing out the tab you
    changed it in.
    """
    user = await make_db_user(db_session)
    keep, keep_raw = await start_session(user.id, db_session)
    _other, other_raw = await start_session(user.id, db_session)

    revoked = await revoke_user_sessions(user.id, db_session, except_session_id=keep.id)

    assert len(revoked) == 1
    db_session.expire_all()
    assert await resolve_session(keep_raw, db_session) is not None
    assert await resolve_session(other_raw, db_session) is None


async def test_sessions_do_not_collide_across_users(db_session: AsyncSession) -> None:
    first = await make_db_user(db_session, label="first")
    second = await make_db_user(db_session, label="second")
    _s1, first_raw = await start_session(first.id, db_session)
    _s2, second_raw = await start_session(second.id, db_session)

    resolved_first = await resolve_session(first_raw, db_session)
    resolved_second = await resolve_session(second_raw, db_session)

    assert resolved_first is not None and resolved_first[1].id == first.id
    assert resolved_second is not None and resolved_second[1].id == second.id


async def test_two_concurrent_reset_confirms_consume_the_token_once(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    from app.auth.tokens import create_opaque_token
    from app.models.password_reset_token import PasswordResetToken
    from app.services.password_reset import consume_password_reset_token

    first, second, user_id = concurrent_sessions
    raw, token_hash = create_opaque_token()
    first.add(
        PasswordResetToken(
            user_id=user_id,
            token_hash=token_hash,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    await first.commit()

    async def consume(db: AsyncSession) -> uuid.UUID | None:
        won = await consume_password_reset_token(raw, db)
        await db.commit()
        return won

    outcomes = await asyncio.gather(consume(first), consume(second))
    assert sum(o is not None for o in outcomes) == 1, "exactly one confirm may win"


async def test_concurrent_logins_get_independent_sessions(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    """Two devices signing in at once.

    There is no shared token to race over, so the property is structural rather than timed.
    """
    first, second, user_id = concurrent_sessions

    async def login(db: AsyncSession) -> str:
        _session, raw = await start_session(user_id, db)
        await db.commit()
        return raw

    first_raw, second_raw = await asyncio.gather(login(first), login(second))

    assert first_raw != second_raw
    assert await resolve_session(first_raw, first) is not None
    assert await resolve_session(second_raw, second) is not None


async def test_the_liveness_predicate_is_shared(db_session: AsyncSession) -> None:
    """`resolve_session` and `session_is_live` must not drift apart.

    `_live` is the one predicate both ask, so every clock rejects a session through both doors.
    """
    user = await make_db_user(db_session)
    session, raw = await start_session(user.id, db_session)
    session_id = session.id  # captured before expire_all() below expires `session` too

    for values in (
        {"revoked_at": datetime.now(UTC)},
        {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},
        {"last_used_at": datetime.now(UTC) - timedelta(days=settings.session_idle_days, seconds=1)},
    ):
        await db_session.execute(update(UserSession).where(UserSession.id == session_id).values(**values))
        db_session.expire_all()

        resolved = await resolve_session(raw, db_session)
        live = await session_is_live(session_id, db_session)

        # Reported by hand: the one plausible failure left is the UPDATE not being visible to
        # these reads, and diagnosing that needs the row. Read only on failure.
        if resolved is not None or live:
            row = (await db_session.execute(select(UserSession).where(UserSession.id == session_id))).scalar_one_or_none()
            state = None if row is None else (row.revoked_at, row.expires_at, row.last_used_at)
            raise AssertionError(
                f"applied {values}; row holds (revoked_at, expires_at, last_used_at)={state}; resolved={resolved is not None} live={live}"
            )

        # Restore for the next case, so each one is tested in isolation.
        await db_session.execute(
            update(UserSession)
            .where(UserSession.id == session_id)
            .values(revoked_at=None, expires_at=datetime.now(UTC) + timedelta(days=1), last_used_at=datetime.now(UTC))
        )
        db_session.expire_all()


def test_the_idle_bump_interval_is_far_below_the_idle_window() -> None:
    """A throttle longer than the window would mean a session expires before it is ever slid."""
    assert timedelta(days=settings.session_idle_days) > sessions._IDLE_BUMP_INTERVAL
