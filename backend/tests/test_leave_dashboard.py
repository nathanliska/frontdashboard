"""Leaving a shared dashboard: consent, once given, can be withdrawn.

Every grant is an invite the member redeemed; leaving is the other half of that contract, and
`/shares` stays owner-only, so this route is the member's only handle on their own access.
"""

from httpx import AsyncClient

from tests.helpers import create_dashboard, current_user, register_client, set_csrf, share_dashboard


async def _leave(client: AsyncClient, dashboard_id: str) -> int:
    set_csrf(client)
    return (await client.delete(f"/api/dashboards/{dashboard_id}/membership")).status_code


async def test_a_member_can_leave_and_loses_access(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    editor = await register_client("leave-editor@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], editor, "editor")
        assert dashboard["id"] in [d["id"] for d in (await editor.get("/api/dashboards")).json()]

        assert await _leave(editor, dashboard["id"]) == 204

        # Access is gone at both levels: the listing and the resource itself. (The editor keeps
        # their own default dashboard — only the shared one goes.)
        assert dashboard["id"] not in [d["id"] for d in (await editor.get("/api/dashboards")).json()]
        assert (await editor.get(f"/api/dashboards/{dashboard['id']}")).status_code == 404
    finally:
        await editor.__aexit__(None, None, None)


async def test_a_viewer_can_leave_too(auth_client: AsyncClient) -> None:
    """Leaving is not an edit on the dashboard, so the viewer role must not gate it."""
    dashboard = await create_dashboard(auth_client)

    viewer = await register_client("leave-viewer@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], viewer, "viewer")
        assert await _leave(viewer, dashboard["id"]) == 204
        assert dashboard["id"] not in [d["id"] for d in (await viewer.get("/api/dashboards")).json()]
    finally:
        await viewer.__aexit__(None, None, None)


async def test_the_owner_cannot_leave(auth_client: AsyncClient) -> None:
    """The owner has no share row to shed; their exit is deleting the dashboard."""
    dashboard = await create_dashboard(auth_client)
    assert await _leave(auth_client, dashboard["id"]) == 409


async def test_leaving_twice_is_a_404(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    member = await register_client("leave-twice@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        assert await _leave(member, dashboard["id"]) == 204
        # The first leave revoked access, so the second cannot even see the dashboard.
        assert await _leave(member, dashboard["id"]) == 404
    finally:
        await member.__aexit__(None, None, None)


async def test_a_stranger_gets_a_404(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    stranger = await register_client("leave-stranger@example.com")
    try:
        assert await _leave(stranger, dashboard["id"]) == 404
    finally:
        await stranger.__aexit__(None, None, None)


async def test_the_owner_sees_the_share_gone(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)

    member = await register_client("leave-gone@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        assert len((await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")).json()) == 1

        assert await _leave(member, dashboard["id"]) == 204

        assert (await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")).json() == []
    finally:
        await member.__aexit__(None, None, None)


async def test_leaving_is_logged_as_left_not_removed(auth_client: AsyncClient) -> None:
    """The feed distinguishes "you left" from "you were removed" by share_action, like "joined"."""
    dashboard = await create_dashboard(auth_client)

    member = await register_client("leave-logged@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        assert await _leave(member, dashboard["id"]) == 204

        events = (await member.get("/api/activity")).json()
        (entry,) = [e for e in events if e["event_type"] == "dashboard.share_removed"]
        assert entry["payload"]["share_action"] == "left"
    finally:
        await member.__aexit__(None, None, None)


async def test_leaving_clears_a_home_pointing_at_the_dashboard(auth_client: AsyncClient) -> None:
    """The preference sweep must cover self-removal, or the home screen 404s on next load."""
    dashboard = await create_dashboard(auth_client)

    member = await register_client("leave-home@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        set_csrf(member)
        resp = await member.patch("/api/auth/preferences", json={"home_dashboard_id": dashboard["id"]})
        assert resp.status_code == 200, resp.text

        assert await _leave(member, dashboard["id"]) == 204

        me = await current_user(member)
        assert me["preferences"]["home_dashboard_id"] is None
    finally:
        await member.__aexit__(None, None, None)


async def _mint_invite(owner: AsyncClient, dashboard_id: str, role: str = "editor") -> str:
    set_csrf(owner)
    resp = await owner.post(f"/api/dashboards/{dashboard_id}/invites", json={"role": role})
    assert resp.status_code == 201, resp.text
    return resp.json()["code"]


async def test_leaving_is_not_a_ban_an_invite_re_admits(auth_client: AsyncClient) -> None:
    """Re-entry needs a fresh consent act, and an invite is one.

    Even a code minted before the leave: codes bind to a dashboard and role, not to a person or
    their history.
    """
    dashboard = await create_dashboard(auth_client)
    code = await _mint_invite(auth_client, dashboard["id"])

    member = await register_client("leave-rejoin@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        assert await _leave(member, dashboard["id"]) == 204

        set_csrf(member)
        accepted = await member.post(f"/api/invites/{code}/accept")
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["role"] == "editor"

        assert dashboard["id"] in [d["id"] for d in (await member.get("/api/dashboards")).json()]
    finally:
        await member.__aexit__(None, None, None)


async def test_leave_then_rejoin_then_leave_again(auth_client: AsyncClient) -> None:
    """The cycle must be repeatable: a second leave finds the re-issued share, not stale state."""
    dashboard = await create_dashboard(auth_client)

    member = await register_client("leave-cycle@example.com")
    try:
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        assert await _leave(member, dashboard["id"]) == 204
        await share_dashboard(auth_client, dashboard["id"], member, "editor")
        assert await _leave(member, dashboard["id"]) == 204
        assert dashboard["id"] not in [d["id"] for d in (await member.get("/api/dashboards")).json()]
    finally:
        await member.__aexit__(None, None, None)
