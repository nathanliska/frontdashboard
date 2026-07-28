"""Retention sweep tests — see finding #38.

Every case runs in the savepoint `db_session`, so the deletes are exercised against
a real Postgres and rolled back. The sweep must delete only provably-inert rows and
never touch a token that can still affect an auth decision.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.config import settings
from app.models.activity import ActivityEvent
from app.models.dashboard import Dashboard
from app.models.email_verification_token import EmailVerificationToken
from app.models.list import List
from app.models.notification import Notification
from app.models.password_reset_token import PasswordResetToken
from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User
from app.services.retention import reap_abandoned_signups, reap_expired_auth_rows, reap_expired_history
from tests.helpers import make_db_user


async def test_expired_tokens_deleted_live_and_consumed_ones_kept(db_session):
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
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
    user = await make_db_user(db_session, label="reap")
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
    user = await make_db_user(db_session, label="reap")
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
    user = await make_db_user(db_session, label="reap")
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


async def test_history_older_than_the_horizon_is_pruned(db_session):
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
    horizon = timedelta(days=settings.history_retention_days)

    def activity(created_at: datetime) -> ActivityEvent:
        return ActivityEvent(
            event_type="list.created",
            actor_id=user.id,
            actor_display_name="Reap",
            entity_type="list",
            entity_id=uuid.uuid4(),
            created_at=created_at,
        )

    def notification(created_at: datetime, *, read: bool) -> Notification:
        return Notification(
            user_id=user.id,
            type="list.created",
            title="t",
            body="b",
            read_at=created_at if read else None,
            created_at=created_at,
        )

    stale = now - horizon - timedelta(days=1)
    fresh = now - horizon + timedelta(days=1)
    db_session.add_all(
        [
            activity(stale),
            activity(fresh),
            notification(stale, read=False),
            notification(fresh, read=True),
        ]
    )
    await db_session.flush()

    counts = await reap_expired_history(db_session, now=now)

    assert counts["activity_events"] == 1
    assert counts["notifications"] == 1

    # The horizon is the only criterion — an unread notification past it is still stale, and a
    # read one inside it is still someone's recent history.
    surviving_activity = (await db_session.execute(select(ActivityEvent.created_at).where(ActivityEvent.actor_id == user.id))).scalars().all()
    assert surviving_activity == [fresh]

    surviving_notifications = (await db_session.execute(select(Notification.created_at).where(Notification.user_id == user.id))).scalars().all()
    assert surviving_notifications == [fresh]


async def test_history_sweep_leaves_auth_rows_alone(db_session):
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
    session = UserSession(user_id=user.id, last_used_at=now - timedelta(days=365))
    db_session.add(session)
    await db_session.flush()
    token = RefreshToken(
        session_id=session.id,
        user_id=user.id,
        token_hash=f"keep-{uuid.uuid4()}",
        expires_at=now + timedelta(days=3),
    )
    db_session.add(token)
    await db_session.flush()

    # An old session with a live token is not history — the two sweeps answer different questions
    # and must not bleed into each other.
    await reap_expired_history(db_session, now=now)

    assert await db_session.get(UserSession, session.id) is not None
    assert await db_session.get(RefreshToken, token.id) is not None


async def _make_unverified_signup(db, *, age_days: int):
    """A signup as `register` leaves it: unverified, with one empty auto-created dashboard."""
    created = datetime.now(UTC) - timedelta(days=age_days)
    user = User(
        email=f"abandoned-{uuid.uuid4()}@example.com",
        password_hash="x",
        display_name="Abandoned",
        email_verified_at=None,
        created_at=created,
        updated_at=created,
    )
    db.add(user)
    await db.flush()
    dashboard = Dashboard(user_id=user.id, name="My Dashboard")
    db.add(dashboard)
    await db.flush()
    return user, dashboard


async def test_an_abandoned_unverified_signup_is_purged_with_its_empty_dashboard(db_session):
    """Registration is open to the internet, so these accumulate and never leave on their own."""
    user, dashboard = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)

    counts = await reap_abandoned_signups(db_session)

    assert counts["abandoned_signups"] == 1
    assert (await db_session.execute(select(User).where(User.id == user.id))).scalar_one_or_none() is None
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == dashboard.id))).scalar_one_or_none() is None


async def test_a_recent_unverified_signup_is_left_alone(db_session):
    """Someone who signed up an hour ago has not abandoned anything yet."""
    user, _ = await _make_unverified_signup(db_session, age_days=0)

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == user.id))).scalar_one() is not None


async def test_a_verified_user_is_never_purged_however_old(db_session):
    """The horizon is about *unverified* accounts — a real user is not garbage at any age."""
    user = await make_db_user(db_session, label="real")
    user.created_at = datetime.now(UTC) - timedelta(days=settings.unverified_retention_days * 10)
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == user.id))).scalar_one() is not None


async def test_an_unverified_signup_owning_content_is_skipped_not_cascaded(db_session):
    """The safety guard. Login 403s until verification, so this state should be unreachable —
    which is exactly why it must fail safe. If the invariant ever slips, the sweep declines to
    delete rather than cascading through somebody's data.
    """
    user, dashboard = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    db_session.add(List(dashboard_id=dashboard.id, created_by=user.id, updated_by=user.id, name="Unexpected", list_type="todo"))
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == user.id))).scalar_one() is not None
