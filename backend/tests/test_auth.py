from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.main import app
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from tests.helpers import CSRF, create_dashboard, register_client, set_csrf

_REGISTER_URL = "/api/auth/register"
_LOGIN_URL = "/api/auth/login"
_VERIFY_EMAIL_URL = "/api/auth/verify-email"
_RESEND_VERIFICATION_URL = "/api/auth/resend-verification"
_PASSWORD_RESET_REQUEST_URL = "/api/auth/password-reset/request"
_PASSWORD_RESET_CONFIRM_URL = "/api/auth/password-reset/confirm"
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
    assert "access_token" not in resp.cookies
    assert "refresh_token" not in resp.cookies
    assert "csrf_token" not in resp.cookies
    assert app.state.email_verification_tokens["new@example.com"]


async def test_register_duplicate_email(db_client: AsyncClient) -> None:
    payload = {"email": "dup@example.com", "password": "password123", "display_name": "Dup"}
    await db_client.post(_REGISTER_URL, json=payload)
    resp = await db_client.post(_REGISTER_URL, json=payload)
    assert resp.status_code == 409


async def test_login(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "login@example.com", "password": "mypassword", "display_name": "L"},
    )
    token = app.state.email_verification_tokens["login@example.com"]
    verify = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert verify.status_code == 200

    resp = await db_client.post(_LOGIN_URL, json={"email": "login@example.com", "password": "mypassword"})
    assert resp.status_code == 200
    assert "access_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_login_requires_email_verification(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "unverified@example.com", "password": "mypassword", "display_name": "U"},
    )
    first_token = app.state.email_verification_tokens["unverified@example.com"]
    resp = await db_client.post(_LOGIN_URL, json={"email": "unverified@example.com", "password": "mypassword"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Email verification required"
    assert app.state.email_verification_tokens["unverified@example.com"] == first_token


async def test_verify_email_authenticates_user(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "verify@example.com", "password": "mypassword", "display_name": "Verify"},
    )
    token = app.state.email_verification_tokens["verify@example.com"]

    resp = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert resp.status_code == 200
    assert resp.json()["email"] == "verify@example.com"
    assert resp.json()["email_verified_at"] is not None
    assert "access_token" in resp.cookies
    assert "refresh_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_verify_email_rejects_used_token(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "replay@example.com", "password": "mypassword", "display_name": "Replay"},
    )
    token = app.state.email_verification_tokens["replay@example.com"]

    first = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert first.status_code == 200

    replay = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert replay.status_code == 400
    assert replay.json()["detail"] == "Invalid or expired verification link"


async def test_verify_email_rejects_expired_token(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "expired@example.com", "password": "mypassword", "display_name": "Expired"},
    )
    token = app.state.email_verification_tokens["expired@example.com"]

    result = await db_session.execute(select(EmailVerificationToken).where(EmailVerificationToken.token_hash == hash_token(token)))
    record = result.scalar_one()
    record.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.commit()

    resp = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid or expired verification link"


async def test_resend_verification_issues_new_token(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "resend@example.com", "password": "mypassword", "display_name": "Resend"},
    )
    first_token = app.state.email_verification_tokens["resend@example.com"]

    resp = await db_client.post(_RESEND_VERIFICATION_URL, json={"email": "resend@example.com"})
    assert resp.status_code == 204
    assert app.state.email_verification_tokens["resend@example.com"] != first_token


async def test_login_wrong_password(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "wrong@example.com", "password": "correct", "display_name": "W"},
    )
    resp = await db_client.post(_LOGIN_URL, json={"email": "wrong@example.com", "password": "incorrect"})
    assert resp.status_code == 401


async def test_request_password_reset_issues_token(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "reset@example.com", "password": "oldpassword", "display_name": "Reset"},
    )

    resp = await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "reset@example.com"})

    assert resp.status_code == 204
    assert app.state.password_reset_tokens["reset@example.com"]


async def test_request_password_reset_unknown_email_is_generic(db_client: AsyncClient) -> None:
    resp = await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "missing@example.com"})

    assert resp.status_code == 204
    assert "missing@example.com" not in app.state.password_reset_tokens


async def test_confirm_password_reset_updates_login_credentials(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "confirm-reset@example.com", "password": "oldpassword", "display_name": "Reset"},
    )
    verification_token = app.state.email_verification_tokens["confirm-reset@example.com"]
    verify = await db_client.post(_VERIFY_EMAIL_URL, json={"token": verification_token})
    assert verify.status_code == 200

    request = await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "confirm-reset@example.com"})
    assert request.status_code == 204
    reset_token = app.state.password_reset_tokens["confirm-reset@example.com"]

    resp = await db_client.post(
        _PASSWORD_RESET_CONFIRM_URL,
        json={"token": reset_token, "new_password": "newpassword123"},
    )
    assert resp.status_code == 204

    old_login = await db_client.post(_LOGIN_URL, json={"email": "confirm-reset@example.com", "password": "oldpassword"})
    assert old_login.status_code == 401

    new_login = await db_client.post(_LOGIN_URL, json={"email": "confirm-reset@example.com", "password": "newpassword123"})
    assert new_login.status_code == 200


async def test_confirm_password_reset_rejects_expired_token(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "expired-reset@example.com", "password": "oldpassword", "display_name": "Expired"},
    )
    await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "expired-reset@example.com"})
    reset_token = app.state.password_reset_tokens["expired-reset@example.com"]

    result = await db_session.execute(select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(reset_token)))
    record = result.scalar_one()
    record.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.commit()

    resp = await db_client.post(
        _PASSWORD_RESET_CONFIRM_URL,
        json={"token": reset_token, "new_password": "newpassword123"},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid or expired reset link"


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
    assert csrf is not None
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
    assert csrf is not None
    await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf})
    resp = await auth_client.post(_REFRESH_URL)
    assert resp.status_code == 401


async def test_update_profile(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PROFILE_URL,
        json={"display_name": "Updated User"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "Updated User"
    assert "access_token" in resp.cookies

    me = await auth_client.get(_ME_URL)
    assert me.status_code == 200
    assert me.json()["display_name"] == "Updated User"


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


async def test_update_preferences_accepts_accessible_favorite_dashboards(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client, name="Favorite Dashboard")

    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PREFERENCES_URL,
        json={"favorite_dashboard_ids": [dashboard["id"]]},
    )
    assert resp.status_code == 200
    assert resp.json()["preferences"]["favorite_dashboard_ids"] == [dashboard["id"]]


async def test_update_preferences_rejects_inaccessible_favorite_dashboard(auth_client: AsyncClient) -> None:
    other = await register_client("favorite-owner@example.com", display_name="Favorite Owner")
    try:
        dashboard = await create_dashboard(other, name="Other Favorite Dashboard")

        set_csrf(auth_client)
        resp = await auth_client.patch(
            _PREFERENCES_URL,
            json={"favorite_dashboard_ids": [dashboard["id"]]},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Access denied"
    finally:
        await other.__aexit__(None, None, None)
