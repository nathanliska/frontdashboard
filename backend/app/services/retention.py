"""Retention sweep — removes auth rows that can no longer affect any decision.

See review finding #38. The industry norm is a scheduled reaper, not cleanup on the
write path: it sweeps dormant users too, keeps deletion off the latency-sensitive
login path, and gives a deterministic bound on the oldest row. This module is the
reaper; `reaper_loop` schedules it from the app lifespan.

Only provably-inert rows are deleted:
  - expired refresh / email-verification / password-reset tokens (`expires_at < now`)
  - sessions whose tokens are ALL expired AND that are idle beyond the access-token
    lifetime — so neither a live refresh token nor a still-valid 15-minute access
    token can depend on them.

A consumed-but-unexpired refresh token is NOT deleted: that row is reuse detection's
evidence (a replay is caught by finding it and reading `revoked_at`). Only rows past
`expires_at` go, and a session is kept while ANY unexpired token pins it, so the
sweep can never cascade-delete that evidence.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_factory
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from app.models.refresh_token import RefreshToken
from app.models.session import UserSession

logger = logging.getLogger("app.retention")

_EXPIRING_TOKEN_TABLES = (
    ("refresh_tokens", RefreshToken),
    ("email_verification_tokens", EmailVerificationToken),
    ("password_reset_tokens", PasswordResetToken),
)

# Arbitrary stable 64-bit key scoping the cross-process reaper lock. At most one
# connection holds it, so N app processes can each schedule the sweep and exactly
# one runs it per tick. Never reuse this key for a different advisory lock.
_REAP_ADVISORY_LOCK_KEY = 0x2026_0738


async def reap_expired_auth_rows(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Delete inert auth rows. Returns per-table deleted counts. Caller owns the commit."""
    now = now or datetime.now(UTC)
    counts: dict[str, int] = {}

    for name, model in _EXPIRING_TOKEN_TABLES:
        result = cast("CursorResult[Any]", await db.execute(delete(model).where(model.expires_at < now)))
        counts[name] = result.rowcount

    # A session has no expires_at of its own. It is inert once every token under it has
    # expired (so it can never be refreshed again) AND it has been idle longer than an
    # access token can live (so no still-valid 15-minute access token names it). Keeping
    # it while any unexpired token remains also preserves consumed-but-unexpired reuse
    # evidence — deletion strictly follows the whole token's death.
    idle_cutoff = now - timedelta(minutes=settings.access_token_expire_minutes)
    has_unexpired_token = select(RefreshToken.id).where(RefreshToken.session_id == UserSession.id, RefreshToken.expires_at > now).exists()
    session_result = cast(
        "CursorResult[Any]",
        await db.execute(
            delete(UserSession).where(
                UserSession.last_used_at < idle_cutoff,
                ~has_unexpired_token,
            )
        ),
    )
    counts["sessions"] = session_result.rowcount
    return counts


async def run_reaper_once() -> dict[str, int] | None:
    """Acquire the cross-process lock and reap once, or no-op if another worker holds it.

    Uses a transaction-scoped advisory lock: it releases automatically when the
    transaction ends, so a crash mid-sweep cannot strand it. Returns the deleted
    counts, or None if the lock was not acquired.
    """
    async with async_session_factory() as db, db.begin():
        acquired = (await db.execute(select(func.pg_try_advisory_xact_lock(_REAP_ADVISORY_LOCK_KEY)))).scalar()
        if not acquired:
            logger.debug("reaper: another worker holds the lock; skipping this tick")
            return None
        counts = await reap_expired_auth_rows(db)
    if any(counts.values()):
        logger.info("reaper: deleted %s", counts)
    return counts


async def reaper_loop() -> None:
    """Run the reaper at startup and every `reaper_interval_hours` thereafter.

    Started as a lifespan task and cancelled on shutdown. A transient failure is
    logged and retried next tick rather than killing the loop.
    """
    interval = settings.reaper_interval_hours * 3600
    while True:
        try:
            await run_reaper_once()
        except Exception:
            logger.exception("reaper: sweep failed; retrying next interval")
        await asyncio.sleep(interval)
