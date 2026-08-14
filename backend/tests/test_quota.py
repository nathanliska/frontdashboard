"""Per-creator quotas: the ceiling binds, trash counts against it, and reads never do."""

import pytest
from httpx import AsyncClient

from app.config import settings
from tests.helpers import create_dashboard, create_list, create_list_item, register_client, set_csrf


@pytest.fixture
def tiny_quota(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the caps so a test can reach one without writing 25,000 rows."""
    monkeypatch.setattr(settings, "quota_items_per_user", 2)
    monkeypatch.setattr(settings, "quota_lists_per_user", 2)
    monkeypatch.setattr(settings, "quota_dashboards_per_user", 2)


async def test_creating_past_the_cap_is_refused(auth_client: AsyncClient, tiny_quota: None) -> None:
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    await create_list_item(auth_client, lst["id"], text="one")
    await create_list_item(auth_client, lst["id"], text="two")

    set_csrf(auth_client)
    resp = await auth_client.post(f"/api/lists/{lst['id']}/items", json={"text": "three"})
    assert resp.status_code == 422
    assert "limit of 2 list items" in resp.json()["detail"]


async def test_trashed_rows_still_occupy_the_quota(auth_client: AsyncClient, tiny_quota: None) -> None:
    """The property the whole ceiling rests on.

    Counting live rows only would let anyone create, delete and recreate forever, and a trashed row
    holds its storage until the reaper takes it — so the cap would bound nothing.
    """
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    first = await create_list_item(auth_client, lst["id"], text="one")
    await create_list_item(auth_client, lst["id"], text="two")

    set_csrf(auth_client)
    deleted = await auth_client.delete(f"/api/lists/{lst['id']}/items/{first['id']}")
    assert deleted.status_code == 204

    set_csrf(auth_client)
    resp = await auth_client.post(f"/api/lists/{lst['id']}/items", json={"text": "three"})
    assert resp.status_code == 422


async def test_a_full_account_can_still_read_and_edit(auth_client: AsyncClient, tiny_quota: None) -> None:
    """Quotas gate creation only, which is what grandfathers an account already over a new cap."""
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"], text="one")
    await create_list_item(auth_client, lst["id"], text="two")

    assert (await auth_client.get(f"/api/lists/{lst['id']}")).status_code == 200

    set_csrf(auth_client)
    edited = await auth_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"text": "renamed"})
    assert edited.status_code == 200

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/lists/{lst['id']}/items/{item['id']}")).status_code == 204


async def test_another_users_rows_do_not_count_against_you(auth_client: AsyncClient, tiny_quota: None) -> None:
    """The cap keys on the creator, so a co-member cannot exhaust someone else's allowance."""
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    await create_list_item(auth_client, lst["id"], text="one")
    await create_list_item(auth_client, lst["id"], text="two")

    # A second dashboard owner is untouched by the first one being full.
    other = await register_client("quota-other@example.com")
    try:
        other_dashboard = await create_dashboard(other)
        other_list = await create_list(other, other_dashboard["id"])
        created = await create_list_item(other, other_list["id"], text="mine")
        assert created["text"] == "mine"
    finally:
        await other.__aexit__(None, None, None)


async def test_the_dashboard_cap_binds_on_its_own_axis(auth_client: AsyncClient, tiny_quota: None) -> None:
    # Registration already leaves one dashboard behind, so the cap of 2 admits exactly one more.
    await create_dashboard(auth_client, name="one")

    set_csrf(auth_client)
    resp = await auth_client.post("/api/dashboards", json={"name": "two"})
    assert resp.status_code == 422
    assert "limit of 2 dashboards" in resp.json()["detail"]
