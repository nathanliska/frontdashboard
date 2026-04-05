from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app

_GROUPS_URL = "/api/groups"
_INVITES_URL = "/api/invites"
_REGISTER_URL = "/api/auth/register"


def _csrf(client: AsyncClient) -> str:
    token = client.cookies.get("csrf_token")
    assert token, "No csrf_token cookie — is the client authenticated?"
    return token


async def _make_group(client: AsyncClient, name: str = "Test Group") -> dict:
    resp = await client.post(_GROUPS_URL, json={"name": name}, headers={"X-CSRF-Token": _csrf(client)})
    assert resp.status_code == 201
    return resp.json()


async def _register_second_user(db_session: AsyncSession) -> AsyncClient:
    """Return an authenticated AsyncClient for a second user sharing the same DB session."""
    from app.database import get_db

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    await c.__aenter__()
    resp = await c.post(
        _REGISTER_URL,
        json={"email": "second@example.com", "password": "pw2", "display_name": "Second"},
    )
    assert resp.status_code == 201
    return c


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------


async def test_create_group(auth_client: AsyncClient) -> None:
    data = await _make_group(auth_client)
    assert data["name"] == "Test Group"
    assert data["member_count"] == 1
    assert "id" in data


async def test_create_group_requires_csrf(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_GROUPS_URL, json={"name": "X"})
    assert resp.status_code == 403


async def test_create_group_requires_auth(client: AsyncClient) -> None:
    resp = await client.post(_GROUPS_URL, json={"name": "X"})
    assert resp.status_code == 401


async def test_list_groups_empty(auth_client: AsyncClient) -> None:
    resp = await auth_client.get(_GROUPS_URL)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_groups(auth_client: AsyncClient) -> None:
    await _make_group(auth_client, "Alpha")
    await _make_group(auth_client, "Beta")
    resp = await auth_client.get(_GROUPS_URL)
    assert resp.status_code == 200
    names = [g["name"] for g in resp.json()]
    assert names == ["Alpha", "Beta"]


async def test_get_group(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    resp = await auth_client.get(f"{_GROUPS_URL}/{group['id']}")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Test Group"


async def test_get_group_non_member(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    group = await _make_group(auth_client)
    second = await _register_second_user(db_session)
    try:
        resp = await second.get(f"{_GROUPS_URL}/{group['id']}")
        assert resp.status_code == 404
    finally:
        await second.__aexit__(None, None, None)


async def test_update_group_name(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    resp = await auth_client.patch(
        f"{_GROUPS_URL}/{group['id']}",
        json={"name": "Renamed"},
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"


async def test_delete_group(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    resp = await auth_client.delete(f"{_GROUPS_URL}/{group['id']}", headers={"X-CSRF-Token": _csrf(auth_client)})
    assert resp.status_code == 204
    # Deleted group is no longer listed
    list_resp = await auth_client.get(_GROUPS_URL)
    assert all(g["id"] != group["id"] for g in list_resp.json())


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


async def test_list_members(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    resp = await auth_client.get(f"{_GROUPS_URL}/{group['id']}/members")
    assert resp.status_code == 200
    members = resp.json()
    assert len(members) == 1
    assert members[0]["role"] == "owner"


async def test_leave_group_last_owner_blocked(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    resp = await auth_client.delete(
        f"{_GROUPS_URL}/{group['id']}/members/me",
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    assert resp.status_code == 409


async def test_member_join_and_leave(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    group = await _make_group(auth_client)
    # Create invite
    invite_resp = await auth_client.post(
        f"{_GROUPS_URL}/{group['id']}/invites",
        json={},
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    code = invite_resp.json()["code"]

    second = await _register_second_user(db_session)
    try:
        # Join via invite
        join_resp = await second.post(
            f"{_INVITES_URL}/{code}/join",
            headers={"X-CSRF-Token": second.cookies.get("csrf_token")},
        )
        assert join_resp.status_code == 200
        assert join_resp.json()["role"] == "member"

        # Group now has 2 members
        members_resp = await auth_client.get(f"{_GROUPS_URL}/{group['id']}/members")
        assert len(members_resp.json()) == 2

        # Second user can leave
        leave_resp = await second.delete(
            f"{_GROUPS_URL}/{group['id']}/members/me",
            headers={"X-CSRF-Token": second.cookies.get("csrf_token")},
        )
        assert leave_resp.status_code == 204
    finally:
        await second.__aexit__(None, None, None)


async def test_owner_can_update_and_remove_member(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    group = await _make_group(auth_client)
    invite_resp = await auth_client.post(
        f"{_GROUPS_URL}/{group['id']}/invites",
        json={},
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    assert invite_resp.status_code == 201
    code = invite_resp.json()["code"]

    second = await _register_second_user(db_session)
    try:
        join_resp = await second.post(
            f"{_INVITES_URL}/{code}/join",
            headers={"X-CSRF-Token": second.cookies.get("csrf_token")},
        )
        assert join_resp.status_code == 200

        me_resp = await second.get("/api/auth/me")
        assert me_resp.status_code == 200
        second_user_id = me_resp.json()["id"]

        update_resp = await auth_client.patch(
            f"{_GROUPS_URL}/{group['id']}/members/{second_user_id}",
            json={"role": "admin"},
            headers={"X-CSRF-Token": _csrf(auth_client)},
        )
        assert update_resp.status_code == 200
        assert update_resp.json()["role"] == "admin"

        remove_resp = await auth_client.delete(
            f"{_GROUPS_URL}/{group['id']}/members/{second_user_id}",
            headers={"X-CSRF-Token": _csrf(auth_client)},
        )
        assert remove_resp.status_code == 204

        members_resp = await auth_client.get(f"{_GROUPS_URL}/{group['id']}/members")
        assert members_resp.status_code == 200
        assert len(members_resp.json()) == 1
    finally:
        await second.__aexit__(None, None, None)


# ---------------------------------------------------------------------------
# Invites
# ---------------------------------------------------------------------------


async def test_create_invite(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    resp = await auth_client.post(
        f"{_GROUPS_URL}/{group['id']}/invites",
        json={"expires_in_days": 3, "max_uses": 5},
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["max_uses"] == 5
    assert data["use_count"] == 0
    assert data["revoked"] is False
    assert "code" in data


async def test_list_invites(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    await auth_client.post(
        f"{_GROUPS_URL}/{group['id']}/invites",
        json={},
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    resp = await auth_client.get(f"{_GROUPS_URL}/{group['id']}/invites")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


async def test_revoke_invite(auth_client: AsyncClient) -> None:
    group = await _make_group(auth_client)
    invite = (
        await auth_client.post(
            f"{_GROUPS_URL}/{group['id']}/invites",
            json={},
            headers={"X-CSRF-Token": _csrf(auth_client)},
        )
    ).json()

    resp = await auth_client.patch(
        f"{_GROUPS_URL}/{group['id']}/invites/{invite['id']}/revoke",
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    assert resp.status_code == 204

    # Revoked invite no longer listed
    list_resp = await auth_client.get(f"{_GROUPS_URL}/{group['id']}/invites")
    assert list_resp.json() == []


async def test_join_expired_or_invalid_invite(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(
        f"{_INVITES_URL}/doesnotexist/join",
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    assert resp.status_code == 404


async def test_join_already_member(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    group = await _make_group(auth_client)
    invite_resp = await auth_client.post(
        f"{_GROUPS_URL}/{group['id']}/invites",
        json={},
        headers={"X-CSRF-Token": _csrf(auth_client)},
    )
    code = invite_resp.json()["code"]

    second = await _register_second_user(db_session)
    try:
        await second.post(
            f"{_INVITES_URL}/{code}/join",
            headers={"X-CSRF-Token": second.cookies.get("csrf_token")},
        )
        # Joining a second time should fail
        resp = await second.post(
            f"{_INVITES_URL}/{code}/join",
            headers={"X-CSRF-Token": second.cookies.get("csrf_token")},
        )
        assert resp.status_code == 409
    finally:
        await second.__aexit__(None, None, None)
