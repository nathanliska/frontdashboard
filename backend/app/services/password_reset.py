"""Password-reset token consumption.

Separate from the router so the race can be driven directly, below HTTP.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.models.password_reset_token import PasswordResetToken
from app.services.accounts import lock_live_user


async def reset_token_is_live(raw_token: str, db: AsyncSession) -> bool:
    """Whether a token would still be spendable, without spending it.

    Same predicate as `consume_password_reset_token`, so the form matches what submitting does.
    Yes/no only — naming the account would turn a guessed link into an oracle.
    """
    result = await db.execute(
        select(PasswordResetToken.id).where(
            PasswordResetToken.token_hash == hash_token(raw_token),
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > datetime.now(UTC),
        )
    )
    return result.scalar_one_or_none() is not None


async def consume_password_reset_token(raw_token: str, db: AsyncSession) -> uuid.UUID | None:
    """Atomically spend a reset token. Returns its user_id, or None if unusable.

    The database picks the winner: a read-then-write leaves an Argon2 hash's worth of window
    (~50-100ms) for two concurrent confirms to both spend the same token. The account lock taken
    first, on an unlocked read, also queues them; it is there so that a change of address cannot
    be requested mid-reset and outlive it (FDR-001 §8), and the atomic spend does not lean on it.
    """
    now = datetime.now(UTC)
    owner = await db.execute(select(PasswordResetToken.user_id).where(PasswordResetToken.token_hash == hash_token(raw_token)))
    user_id = owner.scalar_one_or_none()
    if user_id is None:
        return None
    await lock_live_user(db, user_id)
    result = await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.token_hash == hash_token(raw_token),
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > now,
        )
        .values(used_at=now)
        .returning(PasswordResetToken.user_id)
    )
    return result.scalar_one_or_none()
