"""Deleting an account frees the address and detaches the person without orphaning what they wrote."""

from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.models.activity import ActivityEvent
from app.models.calendar import CalendarEventParticipant
from app.models.dashboard import Dashboard
from app.models.dashboard_invite import DashboardInvite
from app.models.list import ListItem
from app.models.notification import Notification
from app.models.session import UserSession
from app.models.user import User
from app.services.accounts import delete_account
from tests.helpers import MemberFactory, create_calendar_event, create_dashboard, create_list, create_list_item, current_user, share_dashboard

_EMAIL = "testuser@example.com"
_PASSWORD = "testpassword123"


async def _delete(client: AsyncClient, password: str = _PASSWORD) -> tuple[int, str]:
    resp = await client.request("DELETE", "/api/auth/account", json={"password": password})
    return resp.status_code, resp.text


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


async def test_deletion_purges_the_private_and_keeps_the_shared(auth_client: AsyncClient, db_session: AsyncSession, accounts: MemberFactory) -> None:
    me = await current_user(auth_client)
    private = await create_dashboard(auth_client, name="Private")
    owner = await accounts("owner@example.com", display_name="Owner")
    theirs = await create_dashboard(owner, name="Theirs")
    await share_dashboard(owner, theirs["id"], auth_client, "editor")
    lst = await create_list(auth_client, theirs["id"], name="Chores")
    item = await create_list_item(auth_client, lst["id"], text="Vacuum")
    event = await create_calendar_event(auth_client, theirs["id"], participants=[me["id"]])
    invite = await auth_client.post(f"/api/dashboards/{private['id']}/invites", json={"role": "viewer"})
    assert invite.status_code == 201, invite.text
    phone = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    assert (await phone.post("/api/auth/login", json={"email": _EMAIL, "password": _PASSWORD})).status_code == 200

    assert (await _delete(auth_client))[0] == 204

    # Every session is revoked, not just the one that asked, and the old credentials resolve to nothing.
    assert (await phone.get("/api/auth/me")).status_code == 401
    assert (await auth_client.get("/api/auth/me")).status_code == 401
    assert (await auth_client.post("/api/auth/login", json={"email": _EMAIL, "password": _PASSWORD})).status_code == 401

    # The address is free again: a fresh registration mints a verification token for it.
    app.state.email_verification_tokens.pop(_EMAIL, None)
    assert (
        await auth_client.post("/api/auth/register", json={"email": _EMAIL, "password": "another-pass-123", "display_name": "New"})
    ).status_code == 201
    assert _EMAIL in app.state.email_verification_tokens

    # Own dashboards and the invites on them are gone outright; the membership and its notification too.
    assert (await db_session.execute(select(Dashboard).where(Dashboard.id == private["id"]))).scalar_one_or_none() is None
    assert (
        await db_session.execute(select(func.count()).select_from(DashboardInvite).where(DashboardInvite.created_by == me["id"]))
    ).scalar_one() == 0
    assert (await db_session.execute(select(func.count()).select_from(Notification).where(Notification.user_id == me["id"]))).scalar_one() == 0
    members = (await owner.get(f"/api/dashboards/{theirs['id']}/members")).json()
    assert [m["display_name"] for m in members] == ["Owner"]

    # What they wrote and where they were named stays, credited to the tombstone.
    kept = (await db_session.execute(select(ListItem).where(ListItem.id == item["id"]))).scalar_one()
    assert str(kept.created_by) == me["id"]
    assert (
        await db_session.execute(
            select(func.count()).select_from(CalendarEventParticipant).where(CalendarEventParticipant.calendar_event_id == event["id"])
        )
    ).scalar_one() == 1
    tombstone = (await db_session.execute(select(User).where(User.id == me["id"]))).scalar_one()
    assert tombstone.deleted_at is not None
    assert tombstone.display_name == "Deleted user"
    assert tombstone.email != _EMAIL
    assert (
        await db_session.execute(
            select(func.count()).select_from(UserSession).where(UserSession.user_id == me["id"], UserSession.revoked_at.is_(None))
        )
    ).scalar_one() == 0
    await phone.aclose()

    # The remaining members were told the way a leave tells them.
    left = (await db_session.execute(select(ActivityEvent).where(ActivityEvent.event_type == "dashboard.share_removed"))).scalars().all()
    assert [e.payload["share_action"] for e in left] == ["left"]


async def test_the_left_frame_is_addressed_to_the_dashboard_before_the_share_goes(
    auth_client: AsyncClient, db_session: AsyncSession, accounts: MemberFactory
) -> None:
    """The audience is the one a leave computes: owner, remaining members and the person going."""
    me = await current_user(auth_client)
    owner = await accounts("owner@example.com", display_name="Owner")
    theirs = await create_dashboard(owner, name="Theirs")
    await share_dashboard(owner, theirs["id"], auth_client, "editor")
    owner_id = (await current_user(owner))["id"]

    leaver = (await db_session.execute(select(User).where(User.id == me["id"]))).scalar_one()
    _revoked, fanouts = await delete_account(db_session, leaver)

    (frame,) = fanouts
    assert frame.user_ids is not None
    assert {str(u) for u in frame.user_ids} == {owner_id, me["id"]}
    assert leaver.display_name == "Deleted user"
