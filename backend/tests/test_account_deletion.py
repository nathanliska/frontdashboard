"""Deleting an account frees the address and detaches the person without orphaning what they wrote."""

import asyncio
import json
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token
from app.main import app
from app.models.activity import ActivityEvent
from app.models.calendar import CalendarEventParticipant
from app.models.dashboard import Dashboard
from app.models.dashboard_invite import DashboardInvite
from app.models.email_verification_token import EmailVerificationToken
from app.models.list import ListItem
from app.models.notification import Notification
from app.models.password_reset_token import PasswordResetToken
from app.models.session import UserSession
from app.models.share import PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.routers import auth as auth_router
from app.services.accounts import delete_account, lock_account
from tests.helpers import (
    MemberFactory,
    create_calendar_event,
    create_dashboard,
    create_list,
    create_list_item,
    current_user,
    mint_invite,
    share_dashboard,
)

_EMAIL = "testuser@example.com"
_PASSWORD = "testpassword123"


async def _delete(client: AsyncClient, password: str = _PASSWORD) -> tuple[int, str]:
    resp = await client.request("DELETE", "/api/auth/account", json={"password": password})
    return resp.status_code, resp.text


async def _count(db: AsyncSession, model: type, *where: Any) -> int:
    return (await db.execute(select(func.count()).select_from(model).where(*where))).scalar_one()


@pytest.fixture
async def deleted_account(auth_client: AsyncClient, db_session: AsyncSession, accounts: MemberFactory) -> AsyncGenerator[dict[str, Any]]:
    """Build a household around one account, delete it, and hand back what is worth looking at.

    Every branch the sweep has to get right is represented: a dashboard owned outright, one owned
    and then handed over, a membership on someone else's, a membership on a trashed one, content
    and a participation written on a dashboard that outlives them, and a share they granted to a
    third party.
    """
    me = await current_user(auth_client)
    owner = await accounts("owner@example.com", display_name="Owner")
    bystander = await accounts("bystander@example.com", display_name="Bystander")

    private = await create_dashboard(auth_client, name="Private")
    await mint_invite(auth_client, private["id"], "viewer")

    handed = await create_dashboard(auth_client, name="Handed")
    handed_code = (await mint_invite(auth_client, handed["id"], "viewer"))["code"]
    await share_dashboard(auth_client, handed["id"], owner, "editor")
    await share_dashboard(auth_client, handed["id"], bystander, "viewer")
    assert (await auth_client.post(f"/api/dashboards/{handed['id']}/owner", json={"user_id": (await current_user(owner))["id"]})).status_code == 200

    theirs = await create_dashboard(owner, name="Theirs")
    await share_dashboard(owner, theirs["id"], auth_client, "editor")
    lst = await create_list(auth_client, theirs["id"], name="Chores")
    item = await create_list_item(auth_client, lst["id"], text="Vacuum")
    event = await create_calendar_event(auth_client, theirs["id"], participants=[me["id"]])

    trashed = await create_dashboard(owner, name="Trashed")
    await share_dashboard(owner, trashed["id"], auth_client, "viewer")
    assert (await owner.delete(f"/api/dashboards/{trashed['id']}")).status_code == 204

    # A notification addressed to this account, a preference, and a live reset token: each is a
    # row the sweep must take, and none of them is created by the deletion itself.
    (share,) = [s for s in (await owner.get(f"/api/dashboards/{theirs['id']}/shares")).json() if s["principal_id"] == me["id"]]
    assert (await owner.patch(f"/api/dashboards/{theirs['id']}/shares/{share['id']}", json={"role": "viewer"})).status_code == 200
    inbox = (await auth_client.get("/api/notifications")).json()["items"]
    assert [n for n in inbox if n["type"] == "dashboard.share_updated"], "the sweep needs a notification of its own to remove"
    assert (await auth_client.patch("/api/auth/preferences", json={"home_dashboard_id": theirs["id"]})).status_code == 200
    _raw, token_hash = create_opaque_token()
    db_session.add(PasswordResetToken(user_id=uuid.UUID(me["id"]), token_hash=token_hash, expires_at=datetime.now(UTC) + timedelta(hours=1)))
    await db_session.flush()

    phone = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    assert (await phone.post("/api/auth/login", json={"email": _EMAIL, "password": _PASSWORD})).status_code == 200

    assert (await _delete(auth_client))[0] == 204

    yield {
        "me": me["id"],
        "owner": owner,
        "bystander_id": (await current_user(bystander))["id"],
        "phone": phone,
        "private": private["id"],
        "handed": handed["id"],
        "handed_code": handed_code,
        "theirs": theirs["id"],
        "item": item["id"],
        "event": event["id"],
    }
    await phone.aclose()


async def test_deletion_is_refused_for_a_wrong_password_or_a_live_dashboard_others_can_see(
    auth_client: AsyncClient, db_session: AsyncSession, accounts: MemberFactory
) -> None:
    dashboard = await create_dashboard(auth_client, name="Household")
    member = await accounts("member@example.com")
    await share_dashboard(auth_client, dashboard["id"], member, "viewer")

    assert (await _delete(auth_client, "not-it"))[0] == 403
    status, text = await _delete(auth_client)
    assert status == 409
    assert "Household" in text
    # Still signed in, still the owner: a refusal changes nothing.
    assert (await auth_client.get("/api/auth/me")).status_code == 200

    # Trashing it clears the block — the members were told at trash time and only the owner could
    # restore — and the trashed row is purged with the account rather than left for the reaper.
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204
    assert (await _delete(auth_client))[0] == 204
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == dashboard["id"]))).scalar_one_or_none() is None


async def test_deletion_ends_every_session_and_frees_the_address(auth_client: AsyncClient, deleted_account: dict[str, Any]) -> None:
    assert (await deleted_account["phone"].get("/api/auth/me")).status_code == 401
    assert (await auth_client.get("/api/auth/me")).status_code == 401
    assert (await auth_client.post("/api/auth/login", json={"email": _EMAIL, "password": _PASSWORD})).status_code == 401

    app.state.email_verification_tokens.pop(_EMAIL, None)
    resp = await auth_client.post("/api/auth/register", json={"email": _EMAIL, "password": "another-pass-123", "display_name": "New"})
    assert resp.status_code == 201
    # The token is the tell: registering against a taken address answers 201 and mints nothing.
    assert _EMAIL in app.state.email_verification_tokens


async def test_deletion_sweeps_what_only_this_account_could_reach(db_session: AsyncSession, deleted_account: dict[str, Any]) -> None:
    me = uuid.UUID(deleted_account["me"])

    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == deleted_account["private"]))).scalar_one_or_none() is None
    # The invite is the one on the handed-over dashboard: the rest went with the purge.
    assert await _count(db_session, DashboardInvite, DashboardInvite.created_by == me) == 0
    assert await _count(db_session, Notification, Notification.user_id == me) == 0
    assert await _count(db_session, EmailVerificationToken, EmailVerificationToken.user_id == me) == 0
    assert await _count(db_session, PasswordResetToken, PasswordResetToken.user_id == me) == 0
    assert await _count(db_session, UserSession, UserSession.user_id == me, UserSession.revoked_at.is_(None)) == 0

    tombstone = (await db_session.execute(select(User).where(User.id == me))).scalar_one()
    assert tombstone.deleted_at is not None
    assert tombstone.display_name == "Deleted user"
    # Unique per account, so a second deletion cannot collide on the address index.
    assert tombstone.email == f"{me}@deleted.invalid"
    assert tombstone.preferences == {}
    assert tombstone.password_hash == "!"


async def test_deletion_keeps_what_the_household_still_needs(db_session: AsyncSession, deleted_account: dict[str, Any]) -> None:
    me = uuid.UUID(deleted_account["me"])
    owner = deleted_account["owner"]

    assert (await owner.get(f"/api/dashboards/{deleted_account['handed']}")).status_code == 200
    members = (await owner.get(f"/api/dashboards/{deleted_account['theirs']}/members")).json()
    assert [m["display_name"] for m in members] == ["Owner"]
    # A grant this account issued to someone else is theirs, not its own access to shed.
    assert (
        await _count(
            db_session, ResourceShare, ResourceShare.granted_by == me, ResourceShare.principal_id == uuid.UUID(deleted_account["bystander_id"])
        )
        == 1
    )

    kept = (await db_session.execute(select(ListItem).where(ListItem.id == deleted_account["item"]))).scalar_one()
    assert kept.created_by == me
    assert await _count(db_session, CalendarEventParticipant, CalendarEventParticipant.calendar_event_id == deleted_account["event"]) == 1

    # One "left" row per live membership — the handed-over one included, the trashed one not,
    # since nobody there could be told.
    mine = (await db_session.execute(select(ActivityEvent).where(ActivityEvent.actor_id == me).order_by(ActivityEvent.event_id))).scalars().all()
    left = [e for e in mine if e.event_type == "dashboard.share_removed"]
    assert sorted(e.payload["dashboard_name"] for e in left) == ["Handed", "Theirs"]
    assert {e.payload["share_action"] for e in left} == {"left"}
    # The rows logged during the deletion are renamed too, not just the ones that predate it.
    assert {e.actor_display_name for e in left} == {"Deleted user"}
    assert {e.actor_display_name for e in mine if e.event_type != "dashboard.share_removed"} == {"Deleted user"}

    # The code minted before the hand-over is gone with the account, not left redeemable.
    assert (await owner.get(f"/api/invites/{deleted_account['handed_code']}")).status_code == 404


async def test_each_left_frame_is_addressed_to_its_own_dashboard_and_keeps_the_name_it_carried(
    auth_client: AsyncClient, db_session: AsyncSession, accounts: MemberFactory
) -> None:
    """One frame per dashboard, each to that dashboard's audience, built before the rename."""
    me = await current_user(auth_client)
    owner = await accounts("owner@example.com", display_name="Owner")
    bystander = await accounts("bystander@example.com", display_name="Bystander")
    owner_id = (await current_user(owner))["id"]
    bystander_id = (await current_user(bystander))["id"]

    crowded = await create_dashboard(owner, name="Crowded")
    await share_dashboard(owner, crowded["id"], auth_client, "editor")
    await share_dashboard(owner, crowded["id"], bystander, "viewer")
    quiet = await create_dashboard(owner, name="Quiet")
    await share_dashboard(owner, quiet["id"], auth_client, "viewer")

    leaver = (await db_session.execute(select(User).where(User.id == me["id"]))).scalar_one()
    assert await lock_account(db_session, leaver) is True
    _revoked, fanouts = await delete_account(db_session, leaver)

    addressed = {json.loads(f.message["data"])["payload"]["dashboard_name"]: f for f in fanouts}
    assert set(addressed) == {"Crowded", "Quiet"}
    assert {str(u) for u in addressed["Crowded"].user_ids or set()} == {owner_id, bystander_id, me["id"]}
    assert {str(u) for u in addressed["Quiet"].user_ids or set()} == {owner_id, me["id"]}
    # Built before the rename, so the members hear the name they knew.
    assert json.loads(addressed["Quiet"].message["data"])["actor_display_name"] == "Test User"


async def _someone_waits_on_a_lock(observer: AsyncSession) -> bool:
    """Poll for a backend blocked on a lock; a fixed sleep can pass before the waiter ever ran."""
    for _ in range(50):
        # The activity view is snapshotted per transaction, and the observer is inside one.
        await observer.execute(text("SELECT pg_stat_clear_snapshot()"))
        query = text("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")
        if await observer.scalar(query):
            return True
        await asyncio.sleep(0.1)
    return False


async def test_the_lock_makes_a_second_submit_wait_and_then_find_nothing_to_do(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    """Two real transactions: the loser must block on the lock rather than re-run the purge."""
    first, second, user_id = concurrent_sessions
    winner = (await first.execute(select(User).where(User.id == user_id))).scalar_one()
    loser = (await second.execute(select(User).where(User.id == user_id))).scalar_one()

    assert await lock_account(first, winner) is True
    waiting = asyncio.create_task(lock_account(second, loser))
    try:
        assert await _someone_waits_on_a_lock(first)
        await delete_account(first, winner)
        await first.commit()
        assert await waiting is False
    finally:
        await first.rollback()
        await asyncio.wait({waiting})
        await second.rollback()


async def test_a_redemption_racing_the_purge_waits_and_then_finds_the_link_dead(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID], auth_client: AsyncClient
) -> None:
    """Without the dashboard lock the redeemer and the purge each hold a row the other needs."""
    first, second, user_id = concurrent_sessions
    dashboard_id = uuid.uuid4()
    code, code_hash = create_opaque_token()
    first.add(Dashboard(id=dashboard_id, user_id=user_id, name="Owned"))
    expires_at = datetime.now(UTC) + timedelta(days=1)
    first.add(DashboardInvite(dashboard_id=dashboard_id, code_hash=code_hash, role="editor", created_by=user_id, expires_at=expires_at))
    await first.commit()
    redeeming: asyncio.Task[Any] | None = None
    try:
        owner = (await first.execute(select(User).where(User.id == user_id))).scalar_one()
        assert await lock_account(first, owner) is True
        redeeming = asyncio.create_task(auth_client.post(f"/api/invites/{code}/accept"))
        assert await _someone_waits_on_a_lock(first)

        await delete_account(first, owner)
        await first.commit()
        assert (await redeeming).status_code == 404
    finally:
        await first.rollback()
        if redeeming is not None:
            await asyncio.wait({redeeming})
        await second.execute(text("SET LOCAL lock_timeout = '5s'"))
        await second.execute(delete(Dashboard).where(Dashboard.id == dashboard_id))
        await second.commit()


async def test_a_password_reset_racing_a_deletion_waits_and_then_finds_its_link_dead(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID], auth_client: AsyncClient
) -> None:
    """The reset takes the account lock before its token, so it waits holding nothing.

    Spending the token first, or the deletion holding the user row, closes a cycle: the deletion
    sweeps that token while the reset waits to write the row.
    """
    # Requested first so it tears down last, after the savepoint that holds the reset's writes.
    first, holding, user_id = concurrent_sessions
    token, token_hash = create_opaque_token()
    first.add(PasswordResetToken(user_id=user_id, token_hash=token_hash, expires_at=datetime.now(UTC) + timedelta(hours=1)))
    await first.commit()

    owner = (await holding.execute(select(User).where(User.id == user_id))).scalar_one()
    assert await lock_account(holding, owner)
    reset = asyncio.create_task(auth_client.post("/api/auth/password-reset/confirm", json={"token": token, "new_password": "otter-lantern-quilt-42"}))
    try:
        assert await _someone_waits_on_a_lock(holding)
        await delete_account(holding, owner)
        await holding.commit()
    finally:
        await holding.rollback()
        await asyncio.wait({reset})
    assert reset.result().status_code == 400, reset.result().text


async def test_a_deletion_that_already_happened_answers_204_and_clears_the_cookies(auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The early return is the loser's path: nothing left to purge, but the cookies must still go."""

    async def already_gone(db: AsyncSession, user: User) -> bool:
        return False

    monkeypatch.setattr(auth_router, "lock_account", already_gone)
    resp = await auth_client.request("DELETE", "/api/auth/account", json={"password": _PASSWORD})

    assert resp.status_code == 204
    cleared = {header.split("=", 1)[0] for header in resp.headers.get_list("set-cookie")}
    assert {auth_router.settings.session_cookie_name, auth_router.settings.csrf_cookie_name} <= cleared


@pytest.mark.parametrize("holder", ["insert", "deletion"])
async def test_the_transfer_waits_on_a_deletion_but_not_on_an_ordinary_write(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID], auth_client: AsyncClient, db_session: AsyncSession, holder: str
) -> None:
    """The transfer waits on the incoming owner's deletion, and on nothing an ordinary write holds.

    Handed to an account mid-deletion, the dashboard would strand on the tombstone. A row lock on
    the owner would also queue behind the key-share an insert takes — a deadlock with any write
    that locks the dashboard first.
    """
    # Requested first so it tears down last, after the savepoint holding a key-share on its user.
    _, holding, member_id = concurrent_sessions
    dashboard = await create_dashboard(auth_client, name="Household")
    owner_id = (await current_user(auth_client))["id"]
    db_session.add(
        ResourceShare(
            resource_type=ResourceType.dashboard,
            resource_id=dashboard["id"],
            principal_type=PrincipalType.user,
            principal_id=member_id,
            role="editor",
            granted_by=owner_id,
        )
    )
    await db_session.flush()

    # This test's own savepoint holds a key-share on the member; were the deletion to lock that row
    # again, it would queue behind it until teardown, and the timeout turns that hang into a failure.
    await holding.execute(text("SET LOCAL lock_timeout = '5s'"))
    member = (await holding.execute(select(User).where(User.id == member_id))).scalar_one()
    if holder == "insert":
        await holding.execute(select(User.id).where(User.id == member_id).with_for_update(read=True, key_share=True))
    else:
        assert await lock_account(holding, member)
    transfer = asyncio.create_task(auth_client.post(f"/api/dashboards/{dashboard['id']}/owner", json={"user_id": str(member_id)}))
    try:
        if holder == "insert":
            await asyncio.wait({transfer}, timeout=5)
            assert transfer.done()
        else:
            assert await _someone_waits_on_a_lock(holding)
            assert not transfer.done()
            await delete_account(holding, member)
            await holding.commit()
    finally:
        await holding.rollback()
        await asyncio.wait({transfer})

    resp = transfer.result()
    assert resp.status_code == (200 if holder == "insert" else 409), resp.text
