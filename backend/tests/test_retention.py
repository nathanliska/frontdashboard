"""Retention sweep tests — see finding #38.

Every case runs in the savepoint `db_session`, so the deletes are exercised against
a real Postgres and rolled back. The sweep must delete only provably-inert rows and
never touch a token that can still affect an auth decision.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.config import settings
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User
from app.services.retention import reap_expired_auth_rows


async def _make_user(db) -> User:
    user = User(
        email=f"reap-{uuid.uuid4()}@example.com",
        password_hash="x",
        display_name="Reap",
        email_verified_at=datetime.now(UTC),
    )
    db.add(user)
    await db.flush()
    return user


async def test_expired_tokens_deleted_live_and_consumed_ones_kept(db_session):
    now = datetime.now(UTC)
    user = await _make_user(db_session)
    session = UserSession(user_id=user.id, last_used_at=now)
    db_session.add(session)
    await db_session.flush()

    live = RefreshToken(session_id=session.id, user_id=user.id, token_hash=f"live-{uuid.uuid4()}", expires_at=now + timedelta(days=3))
    expired = RefreshToken(session_id=session.id, user_id=user.id, token_hash=f"exp-{uuid.uuid4()}", expires_at=now - timedelta(days=1))
    # Consumed but NOT yet expired: this row IS reuse-detection evidence and must survive.
    consumed = RefreshToken(
        session_id=session.id,
        user_id=user.id,
        token_hash=f"con-{uuid.uuid4()}",
        expires_at=now + timedelta(days=2),
        revoked_at=now - timedelta(minutes=1),
    )
    ev_live = EmailVerificationToken(user_id=user.id, token_hash=f"evl-{uuid.uuid4()}", expires_at=now + timedelta(hours=1))
    ev_exp = EmailVerificationToken(user_id=user.id, token_hash=f"eve-{uuid.uuid4()}", expires_at=now - timedelta(hours=1))
    pr_live = PasswordResetToken(user_id=user.id, token_hash=f"prl-{uuid.uuid4()}", expires_at=now + timedelta(hours=1))
    pr_exp = PasswordResetToken(user_id=user.id, token_hash=f"pre-{uuid.uuid4()}", expires_at=now - timedelta(hours=1))
    db_session.add_all([live, expired, consumed, ev_live, ev_exp, pr_live, pr_exp])
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["refresh_tokens"] == 1
    assert counts["email_verification_tokens"] == 1
    assert counts["password_reset_tokens"] == 1

    remaining = (await db_session.execute(select(RefreshToken.token_hash).where(RefreshToken.session_id == session.id))).scalars().all()
    assert set(remaining) == {live.token_hash, consumed.token_hash}
    # Session survives — it still holds unexpired tokens.
    assert await db_session.get(UserSession, session.id) is not None


async def test_idle_session_with_only_expired_tokens_is_deleted(db_session):
    now = datetime.now(UTC)
    user = await _make_user(db_session)
    idle = now - timedelta(minutes=settings.access_token_expire_minutes + 5)
    dead = UserSession(user_id=user.id, last_used_at=idle)
    db_session.add(dead)
    await db_session.flush()
    db_session.add(RefreshToken(session_id=dead.id, user_id=user.id, token_hash=f"d-{uuid.uuid4()}", expires_at=now - timedelta(days=1)))
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["sessions"] == 1
    assert await db_session.get(UserSession, dead.id) is None


async def test_recently_used_session_is_kept_even_with_no_unexpired_token(db_session):
    # Guards the early-logout failure: a still-valid 15-minute access token names it.
    now = datetime.now(UTC)
    user = await _make_user(db_session)
    recent = UserSession(user_id=user.id, last_used_at=now - timedelta(minutes=1))
    db_session.add(recent)
    await db_session.flush()
    db_session.add(RefreshToken(session_id=recent.id, user_id=user.id, token_hash=f"r-{uuid.uuid4()}", expires_at=now - timedelta(days=1)))
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["sessions"] == 0
    assert await db_session.get(UserSession, recent.id) is not None


async def test_idle_session_with_an_unexpired_token_is_kept(db_session):
    # Preserves reuse evidence: any unexpired token (even consumed) pins the session.
    now = datetime.now(UTC)
    user = await _make_user(db_session)
    idle = now - timedelta(days=10)
    pinned = UserSession(user_id=user.id, last_used_at=idle)
    db_session.add(pinned)
    await db_session.flush()
    db_session.add(
        RefreshToken(
            session_id=pinned.id,
            user_id=user.id,
            token_hash=f"u-{uuid.uuid4()}",
            expires_at=now + timedelta(days=1),
            revoked_at=now - timedelta(days=1),
        )
    )
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["sessions"] == 0
    assert await db_session.get(UserSession, pinned.id) is not None
