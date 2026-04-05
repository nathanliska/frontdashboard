from httpx import AsyncClient

from tests.helpers import CSRF, create_dashboard, register_client, set_csrf

_REGISTER_URL = "/api/auth/register"
_LOGIN_URL = "/api/auth/login"
_REFRESH_URL = "/api/auth/refresh"
_LOGOUT_URL = "/api/auth/logout"
_ME_URL = "/api/auth/me"
_PROFILE_URL = "/api/auth/profile"
_PASSWORD_URL = "/api/auth/password"
_PREFERENCES_URL = "/api/auth/preferences"


async def test_register(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "new@example.com", "password": "password123", "display_name": "New User"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["email"] == "new@example.com"
    assert data["display_name"] == "New User"
    assert "id" in data
    assert "access_token" in resp.cookies
    assert "refresh_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_register_duplicate_email(db_client: AsyncClient) -> None:
    payload = {"email": "dup@example.com", "password": "pw", "display_name": "Dup"}
    await db_client.post(_REGISTER_URL, json=payload)
    resp = await db_client.post(_REGISTER_URL, json=payload)
    assert resp.status_code == 409


async def test_login(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "login@example.com", "password": "mypassword", "display_name": "L"},
    )
    resp = await db_client.post(_LOGIN_URL, json={"email": "login@example.com", "password": "mypassword"})
    assert resp.status_code == 200
    assert "access_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_login_wrong_password(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "wrong@example.com", "password": "correct", "display_name": "W"},
    )
    resp = await db_client.post(_LOGIN_URL, json={"email": "wrong@example.com", "password": "incorrect"})
    assert resp.status_code == 401


async def test_me_requires_auth(client: AsyncClient) -> None:
    resp = await client.get(_ME_URL)
    assert resp.status_code == 401


async def test_me_authenticated(auth_client: AsyncClient) -> None:
    resp = await auth_client.get(_ME_URL)
    assert resp.status_code == 200
    assert resp.json()["email"] == "testuser@example.com"


async def test_refresh(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_REFRESH_URL)
    assert resp.status_code == 200
    assert "access_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_refresh_rotates_token(auth_client: AsyncClient) -> None:
    old_refresh = auth_client.cookies.get("refresh_token")
    await auth_client.post(_REFRESH_URL)
    new_refresh = auth_client.cookies.get("refresh_token")
    assert old_refresh != new_refresh


async def test_logout(auth_client: AsyncClient) -> None:
    csrf = auth_client.cookies.get("csrf_token")
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 204


async def test_logout_requires_csrf(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_LOGOUT_URL)
    assert resp.status_code == 403


async def test_logout_wrong_csrf(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": "wrong"})
    assert resp.status_code == 403


async def test_refresh_after_logout_fails(auth_client: AsyncClient) -> None:
    csrf = auth_client.cookies.get("csrf_token")
    await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf})
    resp = await auth_client.post(_REFRESH_URL)
    assert resp.status_code == 401


async def test_update_profile(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PROFILE_URL,
        json={"email": "updated@example.com", "display_name": "Updated User"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["email"] == "updated@example.com"
    assert data["display_name"] == "Updated User"
    assert "access_token" in resp.cookies

    me = await auth_client.get(_ME_URL)
    assert me.status_code == 200
    assert me.json()["email"] == "updated@example.com"


async def test_update_profile_rejects_duplicate_email(auth_client: AsyncClient) -> None:
    other = await register_client("duplicate@example.com", display_name="Duplicate")
    try:
        set_csrf(auth_client)
        resp = await auth_client.patch(_PROFILE_URL, json={"email": "duplicate@example.com"})
        assert resp.status_code == 409
        assert resp.json()["detail"] == "Email already registered"
    finally:
        await other.__aexit__(None, None, None)


async def test_update_profile_rejects_blank_display_name(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(_PROFILE_URL, json={"display_name": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Display name cannot be empty"


async def test_change_password_updates_login_credentials(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PASSWORD_URL,
        json={"current_password": "testpassword123", "new_password": "betterpassword456"},
    )
    assert resp.status_code == 204
    assert "access_token" in resp.cookies

    set_csrf(auth_client)
    logout = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": CSRF})
    assert logout.status_code == 204

    old_login = await auth_client.post(
        _LOGIN_URL,
        json={"email": "testuser@example.com", "password": "testpassword123"},
    )
    assert old_login.status_code == 401

    new_login = await auth_client.post(
        _LOGIN_URL,
        json={"email": "testuser@example.com", "password": "betterpassword456"},
    )
    assert new_login.status_code == 200


async def test_change_password_rejects_wrong_current_password(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PASSWORD_URL,
        json={"current_password": "wrong-password", "new_password": "betterpassword456"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Current password is incorrect"


async def test_update_preferences_accepts_accessible_dashboard(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Secondary Dashboard")

    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PREFERENCES_URL,
        json={"home_dashboard_id": dashboard["id"]},
    )
    assert resp.status_code == 200
    assert resp.json()["preferences"]["home_dashboard_id"] == dashboard["id"]


async def test_update_preferences_rejects_inaccessible_dashboard(auth_client: AsyncClient) -> None:
    other = await register_client("owner@example.com", display_name="Owner")
    try:
        dashboard = await create_dashboard(other, name="Other Dashboard")

        set_csrf(auth_client)
        resp = await auth_client.patch(
            _PREFERENCES_URL,
            json={"home_dashboard_id": dashboard["id"]},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Access denied"
    finally:
        await other.__aexit__(None, None, None)
