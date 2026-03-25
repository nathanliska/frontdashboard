from httpx import AsyncClient

_REGISTER_URL = "/api/auth/register"
_LOGIN_URL = "/api/auth/login"
_REFRESH_URL = "/api/auth/refresh"
_LOGOUT_URL = "/api/auth/logout"
_ME_URL = "/api/auth/me"


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
