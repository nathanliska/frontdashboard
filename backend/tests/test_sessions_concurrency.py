import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User


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
