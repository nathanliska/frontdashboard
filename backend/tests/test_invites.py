import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard_invite import DashboardInvite
from tests.helpers import create_dashboard, register_client, set_csrf


async def _create_invite(client: AsyncClient, dashboard_id: str, role: str = "editor") -> dict:
    set_csrf(client)
    resp = await client.post(f"/api/dashboards/{dashboard_id}/invites", json={"role": role})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_invite_round_trip_grants_the_carried_role(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"], "editor")

    invitee = await register_client("invitee@example.com")
    set_csrf(invitee)

    preview = await invitee.get(f"/api/invites/{invite['code']}")
    assert preview.status_code == 200, preview.text
    assert preview.json()["dashboard_name"] == dashboard["name"]
    assert preview.json()["role"] == "editor"

    accepted = await invitee.post(f"/api/invites/{invite['code']}/accept")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["dashboard_id"] == dashboard["id"]

    # Registration hands every user their own "My Dashboard", so the shared one is an addition.
    listing = await invitee.get("/api/dashboards")
    shared = [d for d in listing.json() if d["id"] == dashboard["id"]]
    assert len(shared) == 1, listing.json()
    assert shared[0]["can_edit"] is True
    await invitee.aclose()


async def test_preview_does_not_consume_the_invite(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    # A link scanner or message preview issues GETs; none of them may burn the code.
    for _ in range(3):
        assert (await auth_client.get(f"/api/invites/{invite['code']}")).status_code == 200

    invitee = await register_client("scanner-victim@example.com")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{invite['code']}/accept")).status_code == 200
    await invitee.aclose()


async def test_an_invite_can_only_be_redeemed_once(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    first = await register_client("first@example.com")
    set_csrf(first)
    assert (await first.post(f"/api/invites/{invite['code']}/accept")).status_code == 200

    second = await register_client("second@example.com")
    set_csrf(second)
    replay = await second.post(f"/api/invites/{invite['code']}/accept")
    assert replay.status_code == 404, replay.text

    listing = await second.get("/api/dashboards")
    assert dashboard["id"] not in [d["id"] for d in listing.json()]
    await first.aclose()
    await second.aclose()


async def test_revoked_invite_cannot_be_previewed_or_redeemed(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    revoke = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/invites/{invite['id']}")
    assert revoke.status_code == 204, revoke.text

    assert (await auth_client.get(f"/api/invites/{invite['code']}")).status_code == 404

    invitee = await register_client("too-late@example.com")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{invite['code']}/accept")).status_code == 404
    await invitee.aclose()


async def test_expired_invite_is_rejected(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    await db_session.execute(
        update(DashboardInvite).where(DashboardInvite.id == uuid.UUID(invite["id"])).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
    )
    await db_session.flush()

    assert (await auth_client.get(f"/api/invites/{invite['code']}")).status_code == 404


async def test_only_the_code_hash_is_stored(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    result = await db_session.execute(select(DashboardInvite).where(DashboardInvite.id == uuid.UUID(invite["id"])))
    row = result.scalar_one()
    # A dumped database must not hand anyone a redeemable code.
    assert invite["code"] not in row.code_hash
    assert row.code_hash != invite["code"]


async def test_listing_invites_never_returns_codes(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    await _create_invite(auth_client, dashboard["id"])

    listing = await auth_client.get(f"/api/dashboards/{dashboard['id']}/invites")
    assert listing.status_code == 200, listing.text
    assert len(listing.json()) == 1
    assert "code" not in listing.json()[0]


async def test_only_share_managers_can_mint_or_revoke_invites(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"], "editor")

    editor = await register_client("editor@example.com")
    set_csrf(editor)
    assert (await editor.post(f"/api/invites/{invite['code']}/accept")).status_code == 200

    # An editor holds write access to the dashboard but must not be able to widen who can see it.
    minted = await editor.post(f"/api/dashboards/{dashboard['id']}/invites", json={"role": "viewer"})
    assert minted.status_code == 403, minted.text
    assert (await editor.get(f"/api/dashboards/{dashboard['id']}/invites")).status_code == 403
    await editor.aclose()


async def test_owner_redeeming_their_own_invite_is_a_no_op(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    accepted = await auth_client.post(f"/api/invites/{invite['code']}/accept")
    assert accepted.status_code == 200, accepted.text

    # Owner is modelled as the absence of a share row; redeeming must not create one.
    shares = await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")
    assert shares.json() == []


async def test_accepting_notifies_the_owner(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    invitee = await register_client("joiner@example.com", display_name="Joiner")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{invite['code']}/accept")).status_code == 200

    notifications = await auth_client.get("/api/notifications")
    assert notifications.status_code == 200, notifications.text
    bodies = [n["body"] for n in notifications.json()]
    assert any("Joiner" in body and dashboard["name"] in body for body in bodies), bodies
    await invitee.aclose()


async def test_invite_for_an_archived_dashboard_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    archived = await auth_client.patch(f"/api/dashboards/{dashboard['id']}", json={"archived": True})
    assert archived.status_code == 200, archived.text

    assert (await auth_client.get(f"/api/invites/{invite['code']}")).status_code == 404
    minted = await auth_client.post(f"/api/dashboards/{dashboard['id']}/invites", json={"role": "viewer"})
    assert minted.status_code == 403, minted.text
