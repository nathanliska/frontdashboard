"""Mint the links an account is emailed, and the units of work that run after a request's answer.

The resend and reset routes answer before any of this runs: the lookup, the lock, the token write
and the send all happen after the 204, so the response's timing cannot say what its body does not
(FDR-001 §11). Each deferred unit opens its own session, the way the retention reaper does.
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import metrics
from app.auth.tokens import create_opaque_token
from app.config import settings
from app.database import async_session_factory
from app.models.email_change_token import EmailChangeToken
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from app.models.user import User
from app.services.accounts import lock_live_user
from app.services.email import send_password_reset_email, send_verification_email

logger = logging.getLogger(__name__)

# The page counts the same minute down (VerifyEmailPage's RESEND_COOLDOWN_SECONDS). A resend inside it
# sends nothing: the link already on its way still works, so another adds only noise to the inbox.
RESEND_COOLDOWN = timedelta(seconds=60)


async def issue_token(
    model: type[EmailVerificationToken] | type[PasswordResetToken] | type[EmailChangeToken],
    user: User,
    db: AsyncSession,
    *,
    expires_in_hours: int,
    path: str,
    **fields: str,
) -> str:
    """Mint a fresh single-use token for `user`, superseding any unused one, and return its link."""
    await db.execute(update(model).where(model.user_id == user.id, model.used_at.is_(None)).values(used_at=datetime.now(UTC)))
    return await mint_token(model, user, db, expires_in_hours=expires_in_hours, path=path, **fields)


async def mint_token(
    model: type[EmailVerificationToken] | type[PasswordResetToken] | type[EmailChangeToken],
    user: User,
    db: AsyncSession,
    *,
    expires_in_hours: int,
    path: str,
    **fields: str,
) -> str:
    now = datetime.now(UTC)
    raw_token, token_hash = create_opaque_token()
    db.add(model(user_id=user.id, token_hash=token_hash, expires_at=now + timedelta(hours=expires_in_hours), **fields))
    await db.flush()
    return f"{settings.frontend_base_url.rstrip('/')}/{path}?token={raw_token}"


async def issue_email_verification(user: User, db: AsyncSession) -> str:
    # Earlier links stay live: every one goes to the same inbox, so voiding them protects nothing and
    # strands whoever opens the first email (FDR-001 §10). Verifying consumes them all.
    return await mint_token(EmailVerificationToken, user, db, expires_in_hours=settings.email_verification_expire_hours, path="verify-email")


async def issue_password_reset(user: User, db: AsyncSession) -> str:
    return await issue_token(PasswordResetToken, user, db, expires_in_hours=settings.password_reset_expire_hours, path="reset-password")


async def _verification_sent_recently(user: User, db: AsyncSession) -> bool:
    # The database's clock on both sides, since `created_at` is stamped server-side.
    recent = select(EmailVerificationToken.id).where(
        EmailVerificationToken.user_id == user.id,
        EmailVerificationToken.created_at > func.now() - RESEND_COOLDOWN,
    )
    return (await db.execute(recent.limit(1))).first() is not None


async def resend_verification_link(email: str) -> None:
    """Mail a fresh verification link to an unverified account, if `email` names one.

    Runs after the route has answered, so a failure is logged and counted; nothing can reach the
    caller. Doing nothing is the normal outcome for an unknown or verified address.
    """
    try:
        async with async_session_factory() as db:
            user = (await db.execute(select(User).where(User.email == email, User.deleted_at.is_(None)))).scalar_one_or_none()
            # The cooldown is read under the account lock, or two resends sent together both find no
            # recent link and each mails one.
            if not (user and (user := await lock_live_user(db, user.id)) and user.email_verified_at is None):
                return
            if await _verification_sent_recently(user, db):
                return
            verification_url = await issue_email_verification(user, db)
            await db.commit()
        await send_verification_email(user.email, verification_url)
    except Exception:
        metrics.AUTH_DEFERRED_FAILURES.labels(operation="verification_resend").inc()
        logger.exception("Deferred verification resend failed")


async def issue_password_reset_link(email: str) -> None:
    """Mail a password reset link to the account `email` names, if any.

    Runs after the route has answered, so a failure is logged and counted; nothing can reach the
    caller. Doing nothing is the normal outcome for an unknown address.
    """
    try:
        async with async_session_factory() as db:
            user = (await db.execute(select(User).where(User.email == email, User.deleted_at.is_(None)))).scalar_one_or_none()
            # Re-read under the account lock: a change of address confirming right now voids the
            # reset links of the old one, and a link issued to it a moment later would escape that.
            if not (user and (user := await lock_live_user(db, user.id)) and user.email == email):
                return
            reset_url = await issue_password_reset(user, db)
            await db.commit()
        await send_password_reset_email(user.email, reset_url)
    except Exception:
        metrics.AUTH_DEFERRED_FAILURES.labels(operation="password_reset").inc()
        logger.exception("Deferred password reset failed")
