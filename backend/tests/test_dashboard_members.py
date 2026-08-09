"""The members listing: everyone with access, owner included, readable by any member."""

from httpx import AsyncClient

from tests.helpers import create_dashboard, register_client, set_csrf


async def _create_invite(client: AsyncClient, dashboard_id: str, role: str) -> dict:
    set_csrf(client)
    resp = await client.post(f"/api/dashboards/{dashboard_id}/invites", json={"role": role})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _join(client: AsyncClient, code: str) -> None:
    set_csrf(client)
    accepted = await client.post(f"/api/invites/{code}/accept")
    assert accepted.status_code == 200, accepted.text


async def test_members_lists_owner_first_then_by_name(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    zoe = await register_client("zoe@example.com", display_name="Zoe")
    ada = await register_client("ada@example.com", display_name="Ada")
    await _join(zoe, (await _create_invite(auth_client, dashboard["id"], "editor"))["code"])
    await _join(ada, (await _create_invite(auth_client, dashboard["id"], "viewer"))["code"])

    resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}/members")
    assert resp.status_code == 200, resp.text

    members = resp.json()
    assert [m["display_name"] for m in members] == ["Test User", "Ada", "Zoe"]
    assert all(set(m) == {"user_id", "display_name"} for m in members), "roles are owner-only detail"
    await zoe.aclose()
    await ada.aclose()


async def test_any_member_may_list_members(auth_client: AsyncClient) -> None:
    """Unlike `/shares`, which is owner-only: an editor's picker has to be able to load this."""
    dashboard = await create_dashboard(auth_client)
    viewer = await register_client("viewer@example.com", display_name="Viewer")
    await _join(viewer, (await _create_invite(auth_client, dashboard["id"], "viewer"))["code"])

    resp = await viewer.get(f"/api/dashboards/{dashboard['id']}/members")
    assert resp.status_code == 200, resp.text
    assert {m["display_name"] for m in resp.json()} == {"Test User", "Viewer"}

    shares = await viewer.get(f"/api/dashboards/{dashboard['id']}/shares")
    assert shares.status_code == 403, shares.text
    await viewer.aclose()


async def test_members_are_exactly_the_sse_audience(auth_client: AsyncClient, db_session) -> None:
    """The invariant both docstrings claim: the picker's set is the set fan-out addresses.

    Two independent constructions of "owner + user principals" — this is what keeps them honest.
    """
    from sqlalchemy import select

    from app.models.dashboard import Dashboard as DashboardModel
    from app.models.share import ResourceType
    from app.services.shares import dashboard_audience_user_ids, get_resource_shares, resolve_member_responses

    dashboard = await create_dashboard(auth_client)
    zoe = await register_client("zoe-audience@example.com", display_name="Zoe")
    await _join(zoe, (await _create_invite(auth_client, dashboard["id"], "viewer"))["code"])

    row = (await db_session.execute(select(DashboardModel).where(DashboardModel.id == dashboard["id"]))).scalar_one()
    shares = await get_resource_shares(ResourceType.dashboard, row.id, db_session)
    members = await resolve_member_responses(row, shares, db_session)

    assert {member.user_id for member in members} == dashboard_audience_user_ids(row, shares)
    assert len(members) == 2
    await zoe.aclose()


async def test_non_members_get_a_404(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    stranger = await register_client("stranger@example.com")

    resp = await stranger.get(f"/api/dashboards/{dashboard['id']}/members")
    assert resp.status_code == 404, resp.text
    await stranger.aclose()
