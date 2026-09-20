"""Pending email-address changes: confirming one, and voiding them.

Separate from the router so the races can be driven directly, below HTTP.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.models.email_change_token import EmailChangeToken
from app.models.password_reset_token import PasswordResetToken
from app.models.user import User
from app.services.accounts import lock_live_user


async def void_email_changes(user_id: uuid.UUID, db: AsyncSession) -> None:
    """Cancel any pending change: a password change or reset is how its owner says "not me"."""
    await db.execute(
        update(EmailChangeToken).where(EmailChangeToken.user_id == user_id, EmailChangeToken.used_at.is_(None)).values(used_at=datetime.now(UTC))
    )


async def confirm_email_change(raw_token: str, db: AsyncSession) -> bool:
    """Spend a change token and switch the address. Caller commits on True and must not on False.

    Reset links already mailed to the old address are voided with it, under the account lock so
    that one requested mid-confirm waits and then finds the address gone. Those rows are taken
    before the change token because the retention sweep takes the two tables in that order.
    """
    now = datetime.now(UTC)
    live = (EmailChangeToken.token_hash == hash_token(raw_token), EmailChangeToken.used_at.is_(None), EmailChangeToken.expires_at > now)
    user_id = (await db.execute(select(EmailChangeToken.user_id).where(*live))).scalar_one_or_none()
    if user_id is None or await lock_live_user(db, user_id) is None:
        return False
    unspent_resets = (PasswordResetToken.user_id == user_id, PasswordResetToken.used_at.is_(None))
    await db.execute(update(PasswordResetToken).where(*unspent_resets).values(used_at=now))
    # The database picks the winner between two confirms of one link, as it does for a reset.
    spend = update(EmailChangeToken).where(*live).values(used_at=now).returning(EmailChangeToken.new_email)
    new_email = (await db.execute(spend)).scalar_one_or_none()
    if new_email is None:
        return False
    try:
        async with db.begin_nested():
            # `deleted_at` in the WHERE: a deletion that won the race leaves nothing to rename.
            changed = await db.execute(update(User).where(User.id == user_id, User.deleted_at.is_(None)).values(email=new_email).returning(User.id))
    except IntegrityError:
        # Someone registered the address after the link was sent; say only that the link is dead.
        return False
    return changed.scalar_one_or_none() is not None
