import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard_invite import DashboardInvite
from tests.helpers import create_calendar_event, create_dashboard, create_list, register_client, set_csrf


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

    # And the response says so: `None` is how this codebase spells owner (`effective_role`), so
    # echoing the link's role here would announce a grant the request deliberately did not make.
    assert accepted.json()["role"] is None


async def test_accepting_notifies_the_owner(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    invitee = await register_client("joiner@example.com", display_name="Joiner")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{invite['code']}/accept")).status_code == 200

    notifications = await auth_client.get("/api/notifications")
    assert notifications.status_code == 200, notifications.text
    bodies = [n["body"] for n in notifications.json()["items"]]
    assert any("Joiner" in body and dashboard["name"] in body for body in bodies), bodies
    await invitee.aclose()


async def test_invite_for_a_trashed_dashboard_is_rejected(auth_client: AsyncClient) -> None:
    """A live link must not outlive the dashboard it grants access to."""
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    trashed = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert trashed.status_code == 204, trashed.text

    assert (await auth_client.get(f"/api/invites/{invite['code']}")).status_code == 404
    assert (await auth_client.post(f"/api/invites/{invite['code']}/accept")).status_code == 404


async def test_invites_cannot_be_managed_on_a_trashed_dashboard(auth_client: AsyncClient) -> None:
    """Minting, listing and revoking stop at the trash, like every other dashboard route.

    The redeem side above was always guarded, but `_dashboard_for_share_management` loaded the
    dashboard with a hand-rolled query that checked `deleted_at` neither in SQL nor in Python —
    the only place in this file that did not. So a trashed dashboard could still mint invite codes
    that `accept_invite` would then refuse: unusable links, issued on request.
    """
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"])

    trashed = await auth_client.delete(f"/api/dashboards/{dashboard['id']}")
    assert trashed.status_code == 204, trashed.text

    set_csrf(auth_client)
    minted = await auth_client.post(f"/api/dashboards/{dashboard['id']}/invites", json={"role": "viewer"})
    assert minted.status_code == 404, minted.text
    assert (await auth_client.get(f"/api/dashboards/{dashboard['id']}/invites")).status_code == 404
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}/invites/{invite['id']}")).status_code == 404


async def test_redeeming_when_you_already_have_more_access_does_not_downgrade(auth_client: AsyncClient) -> None:
    """A link is an offer of access, not an instruction to reduce it.

    `create_share` upserts the role, so an editor who clicked a viewer link used to be silently
    demoted — losing write access to a dashboard they already had it on.
    """
    dashboard = await create_dashboard(auth_client)
    editor_invite = await _create_invite(auth_client, dashboard["id"], "editor")
    viewer_invite = await _create_invite(auth_client, dashboard["id"], "viewer")

    invitee = await register_client("no-downgrade@example.com")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{editor_invite['code']}/accept")).status_code == 200

    accepted = await invitee.post(f"/api/invites/{viewer_invite['code']}/accept")
    assert accepted.status_code == 200, accepted.text
    # Reports what they actually hold, not what the weaker link offered.
    assert accepted.json()["role"] == "editor"

    listing = await invitee.get("/api/dashboards")
    shared = [d for d in listing.json() if d["id"] == dashboard["id"]]
    assert shared[0]["can_edit"] is True
    await invitee.aclose()


async def test_redeeming_when_already_covered_leaves_the_invite_live(auth_client: AsyncClient) -> None:
    """Single-use codes must not be spent by a redemption that grants nothing.

    Consuming first meant an already-shared user burned a code presumably meant for someone else.
    """
    dashboard = await create_dashboard(auth_client)
    first = await _create_invite(auth_client, dashboard["id"], "editor")
    second = await _create_invite(auth_client, dashboard["id"], "editor")

    invitee = await register_client("already-covered@example.com")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{first['code']}/accept")).status_code == 200
    # Same role again: nothing to grant.
    assert (await invitee.post(f"/api/invites/{second['code']}/accept")).status_code == 200

    # The second code was never spent, so its intended recipient can still use it.
    other = await register_client("intended@example.com")
    set_csrf(other)
    redeemed = await other.post(f"/api/invites/{second['code']}/accept")
    assert redeemed.status_code == 200, redeemed.text
    assert redeemed.json()["role"] == "editor"
    await invitee.aclose()
    await other.aclose()


async def test_the_owner_redeeming_their_own_link_does_not_spend_it(auth_client: AsyncClient) -> None:
    """The owner gains nothing from their own link, so it must remain redeemable."""
    dashboard = await create_dashboard(auth_client)
    invite = await _create_invite(auth_client, dashboard["id"], "editor")

    set_csrf(auth_client)
    assert (await auth_client.post(f"/api/invites/{invite['code']}/accept")).status_code == 200

    invitee = await register_client("still-usable@example.com")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{invite['code']}/accept")).status_code == 200
    await invitee.aclose()


async def test_an_upgrade_still_consumes_and_grants(auth_client: AsyncClient) -> None:
    """Being already shared must not block a genuine promotion."""
    dashboard = await create_dashboard(auth_client)
    viewer_invite = await _create_invite(auth_client, dashboard["id"], "viewer")
    editor_invite = await _create_invite(auth_client, dashboard["id"], "editor")

    invitee = await register_client("upgrade-me@example.com")
    set_csrf(invitee)
    assert (await invitee.post(f"/api/invites/{viewer_invite['code']}/accept")).status_code == 200

    upgraded = await invitee.post(f"/api/invites/{editor_invite['code']}/accept")
    assert upgraded.status_code == 200, upgraded.text
    assert upgraded.json()["role"] == "editor"

    listing = await invitee.get("/api/dashboards")
    shared = [d for d in listing.json() if d["id"] == dashboard["id"]]
    assert shared[0]["can_edit"] is True

    # Consumed: the upgrade was a real redemption.
    assert (await invitee.post(f"/api/invites/{editor_invite['code']}/accept")).status_code == 404
    await invitee.aclose()


async def test_an_invite_grants_access_to_the_dashboards_lists_and_events(auth_client: AsyncClient) -> None:
    """The composition nothing covered: invite -> share -> inherited child access.

    The two halves were each tested — that redeeming creates the share, and that a shared
    dashboard's lists and events are reachable — but nothing joined them. Sub-element access is
    derived from `resource_shares` rows rather than from how they were created, so this *should*
    follow; "each half is tested and they meet in the middle" is exactly the reasoning that hid the
    JSONB-null bug, so it is worth asserting rather than deducing.
    """
    dashboard = await create_dashboard(auth_client)
    a_list = await create_list(auth_client, dashboard["id"], name="Groceries")
    await create_calendar_event(auth_client, dashboard["id"], title="Bin day")
    invite = await _create_invite(auth_client, dashboard["id"], "editor")

    invitee = await register_client("inherits@example.com")
    set_csrf(invitee)

    # Before redeeming, the dashboard's children are invisible.
    assert (await invitee.get(f"/api/lists/{a_list['id']}")).status_code == 404

    assert (await invitee.post(f"/api/invites/{invite['code']}/accept")).status_code == 200

    lists = await invitee.get("/api/lists", params={"dashboard_id": dashboard["id"]})
    assert lists.status_code == 200, lists.text
    assert [entry["name"] for entry in lists.json()] == ["Groceries"]
    assert (await invitee.get(f"/api/lists/{a_list['id']}")).status_code == 200

    events = await invitee.get(
        "/api/calendar/events",
        params={
            "window_start": "2026-04-09T00:00:00+00:00",
            "window_end": "2026-04-11T00:00:00+00:00",
            "dashboard_id": dashboard["id"],
        },
    )
    assert events.status_code == 200, events.text
    assert [item["title"] for item in events.json()] == ["Bin day"]

    # The carried role reaches the children too, not just the dashboard listing.
    added = await invitee.post(f"/api/lists/{a_list['id']}/items", json={"text": "Milk"})
    assert added.status_code == 201, added.text
    await invitee.aclose()
