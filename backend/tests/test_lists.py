import uuid

from httpx import ASGITransport, AsyncClient

CSRF = "test-csrf-token"


def _csrf(client: AsyncClient) -> None:
    client.cookies.set("csrf_token", CSRF)
    client.headers.update({"x-csrf-token": CSRF})


async def _make_dashboard(client: AsyncClient, **kwargs) -> dict:
    _csrf(client)
    payload = {"name": "Test Board"} | kwargs
    resp = await client.post("/api/dashboards", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _make_list(client: AsyncClient, dashboard_id: str, **kwargs) -> dict:
    _csrf(client)
    payload = {"name": "Shopping", "list_type": "checklist", "dashboard_id": dashboard_id} | kwargs
    resp = await client.post("/api/lists", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _make_item(client: AsyncClient, list_id: str, text: str = "Milk") -> dict:
    _csrf(client)
    resp = await client.post(f"/api/lists/{list_id}/items", json={"text": text})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _register_client(email: str) -> AsyncClient:
    from app.main import app

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    await client.__aenter__()
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password123", "display_name": "Member"},
    )
    assert resp.status_code == 201
    return client


async def test_private_list_is_only_visible_to_owner(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])
    resp = await auth_client.get("/api/lists", params={"dashboard_id": dashboard["id"]})
    assert resp.status_code == 200
    assert [item["id"] for item in resp.json()] == [lst["id"]]

    other = await _register_client("other@example.com")
    try:
        resp = await other.get(f"/api/lists/{lst['id']}")
        assert resp.status_code == 404
    finally:
        await other.__aexit__(None, None, None)


async def test_shared_dashboard_editor_can_add_items(auth_client: AsyncClient) -> None:
    """A user shared as editor on the dashboard can add items to lists."""
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])

    other = await _register_client("editor@example.com")
    try:
        me = await other.get("/api/auth/me")
        # Share dashboard with other as editor
        _csrf(auth_client)
        share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "editor"},
        )
        assert share_resp.status_code == 201

        # Other can see the list
        resp = await other.get("/api/lists", params={"dashboard_id": dashboard["id"]})
        assert resp.status_code == 200
        assert any(item["id"] == lst["id"] for item in resp.json())

        # Other can add items (editor access)
        item = await _make_item(other, lst["id"], "Eggs")
        assert item["text"] == "Eggs"

        # Other can check items
        _csrf(other)
        checked = await other.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"checked": True})
        assert checked.status_code == 200
        assert checked.json()["checked"] is True
    finally:
        await other.__aexit__(None, None, None)


async def test_shared_dashboard_viewer_cannot_mutate(auth_client: AsyncClient) -> None:
    """A viewer on the dashboard can read lists but not edit them."""
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])

    other = await _register_client("viewer@example.com")
    try:
        me = await other.get("/api/auth/me")
        _csrf(auth_client)
        await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "viewer"},
        )

        # Can read the list
        resp = await other.get(f"/api/lists/{lst['id']}")
        assert resp.status_code == 200

        # Cannot rename
        _csrf(other)
        renamed = await other.patch(f"/api/lists/{lst['id']}", json={"name": "Nope"})
        assert renamed.status_code == 403
    finally:
        await other.__aexit__(None, None, None)


async def test_no_share_returns_404_for_other_user(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])
    other = await _register_client("no-share@example.com")
    try:
        _csrf(other)
        resp = await other.patch(f"/api/lists/{lst['id']}", json={"name": "Blocked"})
        assert resp.status_code == 404
    finally:
        await other.__aexit__(None, None, None)


async def test_dashboard_share_crud_endpoints(auth_client: AsyncClient) -> None:
    """Dashboard share CRUD (list shares are dashboard-managed)."""
    dashboard = await _make_dashboard(auth_client)

    other = await _register_client("share-crud@example.com")
    try:
        me = await other.get("/api/auth/me")
        _csrf(auth_client)
        share_resp = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "viewer"},
        )
        assert share_resp.status_code == 201
        share = share_resp.json()

        resp = await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")
        assert resp.status_code == 200
        assert any(item["id"] == share["id"] for item in resp.json())

        _csrf(auth_client)
        updated = await auth_client.patch(
            f"/api/dashboards/{dashboard['id']}/shares/{share['id']}",
            json={"role": "editor"},
        )
        assert updated.status_code == 200
        assert updated.json()["role"] == "editor"

        _csrf(auth_client)
        deleted = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/shares/{share['id']}")
        assert deleted.status_code == 204
    finally:
        await other.__aexit__(None, None, None)


async def test_delete_list_works_for_dashboard_owner(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])

    _csrf(auth_client)
    resp = await auth_client.delete(f"/api/lists/{lst['id']}")
    assert resp.status_code == 204

    # Confirm it's gone
    get_resp = await auth_client.get(f"/api/lists/{lst['id']}")
    assert get_resp.status_code == 404


async def test_list_shares_returns_dashboard_managed_response(auth_client: AsyncClient) -> None:
    """List share endpoints indicate permissions are managed on the dashboard."""
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])

    resp = await auth_client.get(f"/api/lists/{lst['id']}/shares")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["direct_shares"] == []
    assert len(payload["inherited_dashboards"]) == 1
    assert payload["inherited_dashboards"][0]["dashboard_id"] == dashboard["id"]


async def test_list_share_writes_return_dashboard_managed_error(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])
    share_id = uuid.uuid4()

    _csrf(auth_client)
    create_resp = await auth_client.post(f"/api/lists/{lst['id']}/shares")
    assert create_resp.status_code == 409
    assert create_resp.json()["detail"] == "List permissions are managed on the parent dashboard"

    _csrf(auth_client)
    update_resp = await auth_client.patch(f"/api/lists/{lst['id']}/shares/{share_id}")
    assert update_resp.status_code == 409
    assert update_resp.json()["detail"] == "List permissions are managed on the parent dashboard"

    _csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/lists/{lst['id']}/shares/{share_id}")
    assert delete_resp.status_code == 409
    assert delete_resp.json()["detail"] == "List permissions are managed on the parent dashboard"
