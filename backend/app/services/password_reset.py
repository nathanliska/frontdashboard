"""Password-reset token consumption.

Separate from the router so the race can be driven directly: it happens below
HTTP, and the route needs a live email flow to reach.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.models.password_reset_token import PasswordResetToken


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
