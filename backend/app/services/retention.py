"""Retention sweep — deletes rows that can no longer affect any decision.

Only provably-inert rows go: expired tokens and invites, sessions past either clock, and
activity/notification history past the horizon. Pruning history is safe for SSE resume: a client's
mark is only compared against the log's head, so a reconnect resyncs and never reads history.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import metrics
from app.config import settings
from app.database import async_session_factory
from app.models.activity import ActivityEvent
from app.models.calendar import CalendarEvent, CalendarEventOverride, CalendarEventParticipant
from app.models.dashboard import Dashboard, DashboardWidget
from app.models.dashboard_invite import DashboardInvite
from app.models.email_verification_token import EmailVerificationToken
from app.models.list import List, ListItem
from app.models.notification import Notification
from app.models.password_reset_token import PasswordResetToken
from app.models.session import UserSession
from app.models.share import ResourceShare
from app.models.user import User

logger = logging.getLogger("app.retention")

_EXPIRING_TOKEN_TABLES = (
    ("email_verification_tokens", EmailVerificationToken),
    ("password_reset_tokens", PasswordResetToken),
    # Same shape and the same reasoning: an expired invite can never be redeemed again.
    ("dashboard_invites", DashboardInvite),
)

# Arbitrary but stable: one connection holds it, so exactly one worker sweeps per tick.
# Never reuse this key for a different advisory lock.
_REAP_ADVISORY_LOCK_KEY = 0x2026_0738

# When email verification shipped (migration y2a4c6e8g0i2, nullable and never backfilled). Only
# after this date does a NULL `email_verified_at` mean "never verified".
_EMAIL_VERIFICATION_SHIPPED = datetime(2026, 4, 30, tzinfo=UTC)


async def reap_expired_auth_rows(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Delete inert auth rows. Returns per-table deleted counts. Caller owns the commit."""
    now = now or datetime.now(UTC)
    counts: dict[str, int] = {}

    for name, model in _EXPIRING_TOKEN_TABLES:
        result = cast("CursorResult[Any]", await db.execute(delete(model).where(model.expires_at < now)))
        counts[name] = result.rowcount

    # A session carries both its clocks (ADR-003), so "inert" is decidable from the row alone —
    # the same predicate `services/sessions._live` already refuses to authenticate against.
    session_result = cast(
        "CursorResult[Any]",
        await db.execute(
            delete(UserSession).where(
                or_(
                    UserSession.expires_at < now,
                    UserSession.last_used_at < now - timedelta(days=settings.session_idle_days),
                )
            )
        ),
    )
    counts["sessions"] = session_result.rowcount
    return counts


async def reap_expired_history(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Delete activity and notification rows past the retention horizon. Caller owns the commit."""
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=settings.history_retention_days)
    counts: dict[str, int] = {}

    # Sequential scans, deliberately: four a day beats an index write on every event. Notifications
    # go first so an interrupted sweep strands a reference rather than orphaning a notification.
    for name, model in (("notifications", Notification), ("activity_events", ActivityEvent)):
        result = cast("CursorResult[Any]", await db.execute(delete(model).where(model.created_at < cutoff)))
        counts[name] = result.rowcount

    return counts


async def reap_expired_trash(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Purge trash past `trash_retention_days`. Caller owns the commit.

    Children go before dashboards: their `dashboard_id` FKs have no ON DELETE cascade, while
    `resource_shares.resource_id` does, so share rows need no sweep of their own. `purge_dashboard`
    below encodes the same FK knowledge for a single row; a coverage test ties the two together.
    """
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=settings.trash_retention_days)
    counts: dict[str, int] = {}

    expired_dashboard_ids = select(Dashboard.id).where(Dashboard.deleted_at < cutoff).scalar_subquery()

    # Lists die if individually trashed past the horizon OR owned by a purging dashboard.
    doomed_lists = or_(List.deleted_at < cutoff, List.dashboard_id.in_(expired_dashboard_ids))
    doomed_list_ids = select(List.id).where(doomed_lists).scalar_subquery()
    # Only as a list's cascade: an item deleted on its own is already gone (ADR-007).
    item_result = cast(
        "CursorResult[Any]",
        await db.execute(delete(ListItem).where(ListItem.list_id.in_(doomed_list_ids))),
    )
    list_result = cast("CursorResult[Any]", await db.execute(delete(List).where(doomed_lists)))
    counts["lists"] = list_result.rowcount
    counts["list_items"] = item_result.rowcount

    doomed_events = or_(
        CalendarEvent.deleted_at < cutoff,
        CalendarEvent.dashboard_id.in_(expired_dashboard_ids),
    )
    event_result = cast("CursorResult[Any]", await db.execute(delete(CalendarEvent).where(doomed_events)))
    counts["calendar_events"] = event_result.rowcount

    await db.execute(delete(DashboardWidget).where(DashboardWidget.dashboard_id.in_(expired_dashboard_ids)))
    dashboard_result = cast(
        "CursorResult[Any]",
        await db.execute(delete(Dashboard).where(Dashboard.deleted_at < cutoff)),
    )
    counts["dashboards"] = dashboard_result.rowcount
    return counts


async def purge_dashboard(db: AsyncSession, dashboard: Dashboard) -> None:
    """Delete one trashed dashboard and its cascade now. Caller owns the commit.

    Same FK ordering as `reap_expired_trash`, for one row rather than a horizon: lists, items and
    events are swept by hand because their `dashboard_id` carries no ON DELETE, while widgets,
    invites and share rows cascade.
    """
    doomed_list_ids = select(List.id).where(List.dashboard_id == dashboard.id).scalar_subquery()
    await db.execute(delete(ListItem).where(ListItem.list_id.in_(doomed_list_ids)))
    await db.execute(delete(List).where(List.dashboard_id == dashboard.id))
    await db.execute(delete(CalendarEvent).where(CalendarEvent.dashboard_id == dashboard.id))
    await db.delete(dashboard)


async def purge_list(db: AsyncSession, lst: List) -> None:
    """Delete one trashed list and its items now. Caller owns the commit."""
    await db.execute(delete(ListItem).where(ListItem.list_id == lst.id))
    await db.delete(lst)


async def reap_abandoned_signups(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Purge unverified signups past `unverified_retention_days`. Caller owns the commit.

    Safe because login 403s while `email_verified_at` is NULL, so the account has never held a
    session and owns nothing but its empty default dashboard. Two guards keep real accounts out:
    the `_EMAIL_VERIFICATION_SHIPPED` floor and per-user disqualification, both below.
    """
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=settings.unverified_retention_days)

    # Every foreign key to `users.id` the sweep does not itself delete, evaluated per user. None
    # carries ON DELETE, so a missing one doesn't skip that user — it raises IntegrityError and
    # rolls back the whole tick, which shares one transaction.
    disqualifying = or_(
        *(
            select(column).where(column == User.id).exists()
            for column in (
                List.created_by,
                List.updated_by,
                ListItem.created_by,
                ListItem.updated_by,
                ListItem.assigned_to,
                CalendarEvent.created_by,
                CalendarEvent.updated_by,
                CalendarEventOverride.created_by,
                CalendarEventOverride.updated_by,
                CalendarEventParticipant.user_id,
                ResourceShare.granted_by,
            )
        ),
        # Widgets carry no author column, so owning a dashboard holding one is the only signal.
        select(DashboardWidget.id).join(Dashboard, Dashboard.id == DashboardWidget.dashboard_id).where(Dashboard.user_id == User.id).exists(),
    )

    # The floor is load-bearing: disqualification alone can't tell a pre-gate account that only
    # ever viewed a shared dashboard from an abandoned signup — neither authored anything.
    eligible = (
        User.email_verified_at.is_(None),
        User.created_at < cutoff,
        User.created_at >= _EMAIL_VERIFICATION_SHIPPED,
    )

    # A list, not a subquery: every DELETE below would otherwise re-evaluate it after earlier
    # statements had removed rows it reads.
    candidate_ids = list((await db.execute(select(User.id).where(*eligible, ~disqualifying))).scalars().all())
    skipped = (await db.execute(select(func.count()).select_from(User).where(*eligible, disqualifying))).scalar_one()
    predating = (
        await db.execute(
            select(func.count()).select_from(User).where(User.email_verified_at.is_(None), User.created_at < _EMAIL_VERIFICATION_SHIPPED)
        )
    ).scalar_one()
    if predating:
        logger.info("reaper: %s account(s) predate email verification and are never purge candidates", predating)
    if skipped:
        logger.info("reaper: %s unverified account(s) own content and were left alone", skipped)
    if not candidate_ids:
        return {"abandoned_signups": 0}

    candidates = candidate_ids
    doomed_dashboards = select(Dashboard.id).where(Dashboard.user_id.in_(candidates)).scalar_subquery()
    # Ordered by dependency: `resource_shares.resource_id` cascades from dashboards, but
    # `principal_id` does not, and the rest have no cascade at all.
    await db.execute(delete(ResourceShare).where(ResourceShare.principal_id.in_(candidates)))
    await db.execute(delete(Notification).where(Notification.user_id.in_(candidates)))
    await db.execute(delete(ActivityEvent).where(ActivityEvent.actor_id.in_(candidates)))
    await db.execute(delete(DashboardInvite).where(DashboardInvite.created_by.in_(candidates)))
    await db.execute(delete(UserSession).where(UserSession.user_id.in_(candidates)))
    await db.execute(delete(EmailVerificationToken).where(EmailVerificationToken.user_id.in_(candidates)))
    await db.execute(delete(PasswordResetToken).where(PasswordResetToken.user_id.in_(candidates)))
    await db.execute(delete(Dashboard).where(Dashboard.id.in_(doomed_dashboards)))

    user_result = cast("CursorResult[Any]", await db.execute(delete(User).where(User.id.in_(candidates))))
    return {"abandoned_signups": user_result.rowcount}


async def run_reaper_once() -> dict[str, int] | None:
    """Acquire the cross-process lock and reap once, or None if another worker holds it.

    The advisory lock is transaction-scoped, so a crash mid-sweep cannot strand it.
    """
    async with async_session_factory() as db, db.begin():
        acquired = (await db.execute(select(func.pg_try_advisory_xact_lock(_REAP_ADVISORY_LOCK_KEY)))).scalar()
        if not acquired:
            logger.debug("reaper: another worker holds the lock; skipping this tick")
            return None
        counts = await reap_expired_auth_rows(db)
        counts |= await reap_expired_history(db)
        counts |= await reap_expired_trash(db)
        counts |= await reap_abandoned_signups(db)
    if any(counts.values()):
        logger.info("reaper: deleted %s", counts)
    return counts


async def reaper_loop() -> None:
    """Run the reaper at startup and every `reaper_interval_hours` thereafter.

    A lifespan task, cancelled on shutdown; a transient failure is retried next tick.
    """
    interval = settings.reaper_interval_hours * 3600
    while True:
        try:
            await run_reaper_once()
            metrics.REAPER_SWEEPS.inc()
            # A stalled sweep is otherwise silent: nothing else reveals that history stopped
            # being pruned until the tables are already large.
            metrics.REAPER_LAST_SUCCESS.set(datetime.now(UTC).timestamp())
        except Exception:
            metrics.REAPER_FAILURES.inc()
            logger.exception("reaper: sweep failed; retrying next interval")
        await asyncio.sleep(interval)
