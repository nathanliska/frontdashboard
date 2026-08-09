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
from app.models.calendar import CalendarEvent, CalendarEventParticipant
from app.models.dashboard import Dashboard
from app.models.email_verification_token import EmailVerificationToken
from app.models.list import List
from app.models.notification import Notification
from app.models.password_reset_token import PasswordResetToken
from app.models.session import UserSession
from app.models.share import ResourceShare
from app.models.user import User
from app.services.retention import (
    _EMAIL_VERIFICATION_SHIPPED,
    reap_abandoned_signups,
    reap_expired_auth_rows,
    reap_expired_history,
)
from tests.helpers import make_db_dashboard, make_db_user


def _session(user_id, now, *, idle: timedelta = timedelta(0), expires_in: timedelta = timedelta(days=30)) -> UserSession:
    return UserSession(
        user_id=user_id,
        token_hash=f"t-{uuid.uuid4()}",
        last_used_at=now - idle,
        expires_at=now + expires_in,
    )


async def test_expired_tokens_deleted_and_live_ones_kept(db_session):
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
    session = _session(user.id, now)
    db_session.add(session)
    await db_session.flush()

    ev_live = EmailVerificationToken(user_id=user.id, token_hash=f"evl-{uuid.uuid4()}", expires_at=now + timedelta(hours=1))
    ev_exp = EmailVerificationToken(user_id=user.id, token_hash=f"eve-{uuid.uuid4()}", expires_at=now - timedelta(hours=1))
    pr_live = PasswordResetToken(user_id=user.id, token_hash=f"prl-{uuid.uuid4()}", expires_at=now + timedelta(hours=1))
    pr_exp = PasswordResetToken(user_id=user.id, token_hash=f"pre-{uuid.uuid4()}", expires_at=now - timedelta(hours=1))
    db_session.add_all([ev_live, ev_exp, pr_live, pr_exp])
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["email_verification_tokens"] == 1
    assert counts["password_reset_tokens"] == 1
    assert await db_session.get(EmailVerificationToken, ev_live.id) is not None
    assert await db_session.get(PasswordResetToken, pr_live.id) is not None
    # A session in current use is untouched.
    assert counts["sessions"] == 0
    assert await db_session.get(UserSession, session.id) is not None


async def test_a_session_idle_past_the_window_is_deleted(db_session):
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
    dead = _session(user.id, now, idle=timedelta(days=settings.session_idle_days, seconds=1))
    db_session.add(dead)
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["sessions"] == 1
    assert await db_session.get(UserSession, dead.id) is None


async def test_a_session_past_its_absolute_expiry_is_deleted(db_session):
    """Only the absolute clock can condemn a recently used session.

    A sweep keyed on idleness alone cannot reach this row.
    """
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
    dead = _session(user.id, now, expires_in=-timedelta(seconds=1))
    db_session.add(dead)
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["sessions"] == 1
    assert await db_session.get(UserSession, dead.id) is None


async def test_a_session_still_inside_both_windows_is_kept(db_session):
    """The early-logout guard: the sweep must never collect a session a request would accept."""
    now = datetime.now(UTC)
    user = await make_db_user(db_session, label="reap")
    alive = _session(user.id, now, idle=timedelta(days=settings.session_idle_days) - timedelta(hours=1))
    db_session.add(alive)
    await db_session.flush()

    counts = await reap_expired_auth_rows(db_session, now=now)

    assert counts["sessions"] == 0
    assert await db_session.get(UserSession, alive.id) is not None


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
    session = _session(user.id, now, idle=timedelta(days=365))
    db_session.add(session)
    await db_session.flush()

    # A session past the *history* horizon is not history: `reap_expired_auth_rows` collects
    # this one, `reap_expired_history` must not.
    await reap_expired_history(db_session, now=now)

    assert await db_session.get(UserSession, session.id) is not None


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


async def test_authoring_on_someone_elses_dashboard_disqualifies(db_session):
    """A reference from *anywhere* disqualifies, not just content on the candidate's own dashboard.

    This is the production shape: an account that predates email verification authored a list on
    another user's dashboard. Checking only dashboards the candidate owns would clear them for
    purge, and `lists.created_by` — NOT NULL, no ON DELETE — would then raise IntegrityError on the
    final DELETE. Because `run_reaper_once` shares one transaction, that would roll back the auth,
    history and trash sweeps for the tick as well.
    """
    author, _ = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    owner = await make_db_user(db_session, label="owner")
    owners_dashboard = await make_db_dashboard(db_session, owner)
    db_session.add(
        List(
            dashboard_id=owners_dashboard.id,
            created_by=author.id,
            updated_by=author.id,
            name="Authored elsewhere",
            list_type="todo",
        )
    )
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == author.id))).scalar_one() is not None


async def test_being_an_event_participant_disqualifies(db_session):
    """A participant row alone must keep an account out of the purge.

    `calendar_event_participants.user_id` has no ON DELETE: a missed sweep entry would roll back
    the whole tick, same shape as authoring content elsewhere.
    """
    participant, _ = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)
    event = CalendarEvent(
        dashboard_id=dashboard.id,
        created_by=owner.id,
        updated_by=owner.id,
        title="Soccer",
        starts_at=datetime(2026, 4, 10, 14, tzinfo=UTC),
        ends_at=datetime(2026, 4, 10, 15, tzinfo=UTC),
        timezone="UTC",
    )
    db_session.add(event)
    await db_session.flush()
    db_session.add(CalendarEventParticipant(calendar_event_id=event.id, user_id=participant.id))
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == participant.id))).scalar_one() is not None


async def test_having_granted_a_share_disqualifies(db_session):
    """`resource_shares.granted_by` is NOT NULL with no ON DELETE, so it blocks the delete too.

    Easy to miss because the sweep already deletes shares where the candidate is the *principal*.
    Being the grantor is the other direction, and nothing removes those rows.
    """
    granter, _ = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    recipient = await make_db_user(db_session, label="recipient")
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)
    db_session.add(
        ResourceShare(
            resource_type="dashboard",
            resource_id=dashboard.id,
            principal_type="user",
            principal_id=recipient.id,
            role="viewer",
            granted_by=granter.id,
        )
    )
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == granter.id))).scalar_one() is not None


async def _make_pre_gate_user(db, *, label: str):
    """Build an account from before email verification existed.

    Anchored to the constant rather than a day count, so it stays pre-gate however long from now
    the suite runs.
    """
    created = _EMAIL_VERIFICATION_SHIPPED - timedelta(days=1)
    user = User(
        email=f"{label}-{uuid.uuid4()}@example.com",
        password_hash="x",
        display_name=label,
        email_verified_at=None,  # y2a4c6e8g0i2 added the column nullable and never backfilled
        created_at=created,
        updated_at=created,
    )
    db.add(user)
    await db.flush()
    db.add(Dashboard(user_id=user.id, name="My Dashboard"))
    await db.flush()
    return user


async def test_an_account_predating_email_verification_is_never_a_candidate(db_session):
    """NULL means "never verified" only for accounts created after the gate shipped.

    Before it the column did not exist, so an ordinary user reads unverified forever. This
    account owns nothing, so only the date floor stands between it and deletion.
    """
    legacy = await _make_pre_gate_user(db_session, label="legacy")

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == legacy.id))).scalar_one_or_none() is not None


async def test_a_pre_gate_viewer_survives_though_it_authored_nothing(db_session):
    """The casualty the disqualifying checks miss entirely.

    A household member shared a dashboard who only ever read it authored nothing, granted nothing
    and was assigned nothing. Being a share principal is not protective — the sweep deletes those.
    """
    legacy = await _make_pre_gate_user(db_session, label="viewer")
    owner = await make_db_user(db_session, label="owner")
    shared = await make_db_dashboard(db_session, owner)
    db_session.add(
        ResourceShare(
            resource_type="dashboard",
            resource_id=shared.id,
            principal_type="user",
            principal_id=legacy.id,
            role="viewer",
            granted_by=owner.id,
        )
    )
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == legacy.id))).scalar_one_or_none() is not None


async def test_a_content_owner_does_not_shield_the_other_abandoned_signups(db_session):
    """Disqualification is per user, not a veto over the whole sweep.

    One account owning content must not shield the rest. Needs two candidates to see, which is
    why an all-or-nothing check looks correct everywhere else.
    """
    empty_user, empty_dashboard = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    content_user, content_dashboard = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    db_session.add(
        List(
            dashboard_id=content_dashboard.id,
            created_by=content_user.id,
            updated_by=content_user.id,
            name="Predates verification",
            list_type="todo",
        )
    )
    await db_session.flush()

    counts = await reap_abandoned_signups(db_session)

    assert counts["abandoned_signups"] == 1
    assert (await db_session.execute(select(User).where(User.id == empty_user.id))).scalar_one_or_none() is None
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == empty_dashboard.id))).scalar_one_or_none() is None
    # The content owner keeps everything — account, dashboard and list.
    assert (await db_session.execute(select(User).where(User.id == content_user.id))).scalar_one() is not None
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == content_dashboard.id))).scalar_one() is not None
    assert (await db_session.execute(select(List).where(List.dashboard_id == content_dashboard.id))).scalar_one() is not None


async def test_an_unverified_signup_owning_content_is_skipped_not_cascaded(db_session):
    """The sweep fails safe when its invariant slips.

    Login 403s until verification, so this state should be unreachable — and if it ever is
    reached, the sweep declines to delete rather than cascading through somebody's data.
    """
    user, dashboard = await _make_unverified_signup(db_session, age_days=settings.unverified_retention_days + 1)
    db_session.add(List(dashboard_id=dashboard.id, created_by=user.id, updated_by=user.id, name="Unexpected", list_type="todo"))
    await db_session.flush()

    assert (await reap_abandoned_signups(db_session))["abandoned_signups"] == 0
    assert (await db_session.execute(select(User).where(User.id == user.id))).scalar_one() is not None
