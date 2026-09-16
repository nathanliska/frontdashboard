"""Ownership moves to a member in one transaction; the old owner stays on as an editor."""

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from tests.helpers import MemberFactory, create_dashboard, current_user, share_dashboard


async def _transfer(owner: AsyncClient, dashboard_id: str, user_id: str) -> tuple[int, dict]:
    resp = await owner.post(f"/api/dashboards/{dashboard_id}/owner", json={"user_id": user_id})
    return resp.status_code, resp.json()


async def test_transfer_swaps_the_two_roles_and_nothing_else(auth_client: AsyncClient, accounts: MemberFactory) -> None:
    dashboard = await create_dashboard(auth_client, name="Household")
    member = await accounts("heir@example.com", display_name="Heir")
    bystander = await accounts("bystander@example.com", display_name="Bystander")
    await share_dashboard(auth_client, dashboard["id"], member, "viewer")
    await share_dashboard(auth_client, dashboard["id"], bystander, "viewer")
    heir_id = (await current_user(member))["id"]
    old_owner_id = (await current_user(auth_client))["id"]

    status, summary = await _transfer(auth_client, dashboard["id"], heir_id)
    assert status == 200, summary
    # The caller's own view of the dashboard, as it now is: editable, not theirs to share.
    assert (summary["user_id"], summary["can_edit"], summary["can_manage_shares"]) == (heir_id, True, False)

    # The new owner manages sharing; the old owner is one of the grants, issued by the new owner.
    shares = await member.get(f"/api/dashboards/{dashboard['id']}/shares")
    assert shares.status_code == 200, shares.text
    by_principal = {s["principal_id"]: s for s in shares.json()}
    assert set(by_principal) == {old_owner_id, (await current_user(bystander))["id"]}
    assert (by_principal[old_owner_id]["role"], by_principal[old_owner_id]["granted_by"]) == ("editor", heir_id)
    assert by_principal[(await current_user(bystander))["id"]]["role"] == "viewer"

    assert (await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")).status_code == 403
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 403
    assert (await member.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204


async def test_transfer_is_owner_only_and_needs_an_existing_member(auth_client: AsyncClient, accounts: MemberFactory) -> None:
    dashboard = await create_dashboard(auth_client)
    editor = await accounts("editor@example.com")
    stranger = await accounts("stranger@example.com")
    await share_dashboard(auth_client, dashboard["id"], editor, "editor")
    editor_id = (await current_user(editor))["id"]
    stranger_id = (await current_user(stranger))["id"]
    owner_id = (await current_user(auth_client))["id"]

    assert (await _transfer(editor, dashboard["id"], editor_id))[0] == 403
    assert (await _transfer(stranger, dashboard["id"], stranger_id))[0] == 404
    assert (await _transfer(auth_client, dashboard["id"], stranger_id))[0] == 409
    assert (await _transfer(auth_client, dashboard["id"], owner_id))[0] == 409
    # Nothing moved.
    assert (await auth_client.get(f"/api/dashboards/{dashboard['id']}")).json()["user_id"] == owner_id


async def test_transfer_is_logged_and_the_new_owner_is_told(auth_client: AsyncClient, db_session: AsyncSession, accounts: MemberFactory) -> None:
    dashboard = await create_dashboard(auth_client, name="Household")
    member = await accounts("heir@example.com", display_name="Heir")
    await share_dashboard(auth_client, dashboard["id"], member, "editor")
    heir_id = (await current_user(member))["id"]

    assert (await _transfer(auth_client, dashboard["id"], heir_id))[0] == 200

    result = await db_session.execute(select(ActivityEvent).where(ActivityEvent.event_type == "dashboard.share_updated"))
    (event,) = result.scalars().all()
    assert (event.payload["share_action"], event.payload["principal_id"], event.payload["role"]) == ("transferred", heir_id, "owner")

    notifications = (await member.get("/api/notifications")).json()["items"]
    (told,) = [n for n in notifications if n["type"] == "dashboard.share_updated"]
    assert told["body"] == 'Test User made you the owner of "Household".'
