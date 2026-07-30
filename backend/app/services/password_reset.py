"""Password-reset token consumption.

Separate from the router so the race can be driven directly: it happens below
HTTP, and the route needs a live email flow to reach.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.models.password_reset_token import PasswordResetToken


async def reset_token_is_live(raw_token: str, db: AsyncSession) -> bool:
    """Whether a token would still be spendable, without spending it.

    Same predicate as `consume_password_reset_token`, so the form a user is shown matches what
    submitting it will do. Answers only yes/no: the token is 256 bits of urandom, so confirming one
    exists reveals nothing, while naming its account would turn a guessed link into an oracle.
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

    The database picks the winner. The read-then-write this replaces let two
    concurrent confirms both observe an unused token and both reset the password —
    and the window was wide, because an Argon2 hash (~50-100ms) sat between the
    read and the commit.
    """
    now = datetime.now(UTC)
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
