from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.hashing import _DUMMY_HASH
from app.auth.tokens import decode_access_token, hash_token
from app.main import app
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from app.models.session import UserSession
from app.models.user import User
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


async def test_register_rejects_blank_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "blankname@example.com", "password": "password123", "display_name": "   "},
    )
    assert resp.status_code == 422


async def test_register_rejects_overlong_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "longname@example.com", "password": "password123", "display_name": "x" * 101},
    )
    assert resp.status_code == 422


async def test_register_accepts_max_length_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "boundary100@example.com", "password": "password123", "display_name": "x" * 100},
    )
    assert resp.status_code == 201


async def test_register_trims_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "trimname@example.com", "password": "password123", "display_name": "  Bob  "},
    )
    assert resp.status_code == 201
    token = app.state.email_verification_tokens["trimname@example.com"]
    verify = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert verify.json()["display_name"] == "Bob"


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


async def test_verify_email_rejects_consumed_token_replay(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "replay@example.com", "password": "mypassword", "display_name": "Replay"},
    )
    token = app.state.email_verification_tokens["replay@example.com"]

    first = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert first.status_code == 200
    assert "access_token" in first.cookies

    replay = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert replay.status_code == 409
    assert replay.json()["detail"] == "Email already verified. Please sign in."
    assert "access_token" not in replay.cookies
    assert "refresh_token" not in replay.cookies
    assert "csrf_token" not in replay.cookies


async def test_verify_email_rejects_invalidated_token_after_resend(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "invalidated@example.com", "password": "mypassword", "display_name": "Invalidated"},
    )
    first_token = app.state.email_verification_tokens["invalidated@example.com"]

    resend = await db_client.post(_RESEND_VERIFICATION_URL, json={"email": "invalidated@example.com"})
    assert resend.status_code == 204

    resp = await db_client.post(_VERIFY_EMAIL_URL, json={"token": first_token})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid or expired verification link"


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


async def test_login_nonexistent_email_still_performs_verify(db_client: AsyncClient, monkeypatch) -> None:
    from app.routers import auth as auth_router

    calls: list[tuple[str, str]] = []
    original = auth_router.verify_password

    async def spy(password: str, hashed: str) -> bool:
        calls.append((password, hashed))
        return await original(password, hashed)

    monkeypatch.setattr(auth_router, "verify_password", spy)

    resp = await db_client.post(_LOGIN_URL, json={"email": "ghost@example.com", "password": "whatever"})
    assert resp.status_code == 401
    # The oracle is closed: a miss must still pay exactly one verify (against the dummy hash).
    assert len(calls) == 1
    # The miss path must verify against the dummy hash, not an empty/attacker-controllable value.
    assert calls[0][1] == _DUMMY_HASH


async def test_login_unknown_and_wrong_password_are_indistinguishable(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "real@example.com", "password": "correctpassword", "display_name": "R"},
    )
    token = app.state.email_verification_tokens["real@example.com"]
    await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})

    unknown = await db_client.post(_LOGIN_URL, json={"email": "ghost@example.com", "password": "x"})
    wrong = await db_client.post(_LOGIN_URL, json={"email": "real@example.com", "password": "wrongpassword"})

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


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


async def test_refresh_requires_csrf(auth_client: AsyncClient) -> None:
    csrf = auth_client.cookies.get("csrf_token")
    assert csrf is not None

    assert (await auth_client.post(_REFRESH_URL)).status_code == 403
    assert (await auth_client.post(_REFRESH_URL, headers={"X-CSRF-Token": "wrong"})).status_code == 403
    assert (await auth_client.post(_REFRESH_URL, headers={"X-CSRF-Token": csrf})).status_code == 200


async def test_refresh(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.post(_REFRESH_URL)
    assert resp.status_code == 200
    assert "access_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_refresh_rotates_token(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
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
    # Logout clears the csrf_token cookie along with the rest — restore the
    # double-submit pair so this exercises "no refresh token" (401), not CSRF (403).
    auth_client.cookies.set("csrf_token", csrf)
    resp = await auth_client.post(_REFRESH_URL, headers={"X-CSRF-Token": csrf})
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


async def test_update_profile_rejects_overlong_display_name(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(_PROFILE_URL, json={"display_name": "x" * 101})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Display name must be at most 100 characters"


async def test_profile_update_bumps_session_last_used_at(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    from datetime import UTC, datetime, timedelta

    session = (await db_session.execute(select(UserSession))).scalars().one()
    old = datetime.now(UTC) - timedelta(hours=1)
    session.last_used_at = old
    await db_session.flush()

    set_csrf(auth_client)
    resp = await auth_client.patch(_PROFILE_URL, json={"display_name": "Bumped"})
    assert resp.status_code == 200

    await db_session.refresh(session)
    assert session.last_used_at is not None
    assert session.last_used_at > old


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


async def test_access_token_carries_the_sid_of_a_real_session(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    session = (await db_session.execute(select(UserSession))).scalars().one()
    assert session.revoked_at is None

    payload = decode_access_token(auth_client.cookies["access_token"])
    assert payload["sid"] == str(session.id)


async def test_a_revoked_session_stops_being_accepted_immediately(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    assert (await auth_client.get(_ME_URL)).status_code == 200

    session = (await db_session.execute(select(UserSession))).scalars().one()
    session.revoked_at = datetime.now(UTC)
    await db_session.commit()

    # The access token is still perfectly valid and unexpired — the session is not.
    # This is #8's authorization half, at request level.
    assert (await auth_client.get(_ME_URL)).status_code == 401


async def _second_device(email: str = "testuser@example.com", password: str = "testpassword123") -> AsyncClient:
    """A second live session for the SAME user — auth_client's own credentials.

    tests.helpers.register_client makes a different ACCOUNT, which is not the same
    thing: revocation is per session, so the test needs one user with two.
    """
    device = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    await device.__aenter__()
    resp = await device.post(_LOGIN_URL, json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return device


async def test_password_change_revokes_other_sessions_but_not_the_callers(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """The containment users expect from a password change — without signing them
    out of the tab they are standing in."""
    other = await _second_device()
    assert (await other.get(_ME_URL)).status_code == 200

    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PASSWORD_URL,
        json={"current_password": "testpassword123", "new_password": "newpassword456"},
    )
    assert resp.status_code == 204, resp.text

    assert (await auth_client.get(_ME_URL)).status_code == 200, "caller keeps their session"
    assert (await other.get(_ME_URL)).status_code == 401, "other devices are signed out"
    await other.aclose()

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert sum(s.revoked_at is None for s in sessions) == 1


async def test_logout_revokes_only_the_current_session(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    other = await _second_device()

    set_csrf(auth_client)
    resp = await auth_client.post(_LOGOUT_URL)
    assert resp.status_code == 204

    assert (await other.get(_ME_URL)).status_code == 200, "other devices are untouched"
    await other.aclose()

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert sum(s.revoked_at is None for s in sessions) == 1


async def test_logout_revokes_without_the_refresh_cookie(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Logout identifies the session from the access token, so it still revokes when
    the refresh cookie is absent — it used to silently no-op."""
    set_csrf(auth_client)
    auth_client.cookies.delete("refresh_token")

    resp = await auth_client.post(_LOGOUT_URL)
    assert resp.status_code == 204

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert sessions, "the session row still exists"
    assert all(s.revoked_at is not None for s in sessions), "the current session was revoked"


async def test_password_reset_revokes_every_session(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """The reset flow is unauthenticated — there is no caller session to spare, so
    unlike a password change this revokes everything."""
    other = await _second_device()

    await auth_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "testuser@example.com"})
    token = app.state.password_reset_tokens["testuser@example.com"]
    resp = await auth_client.post(_PASSWORD_RESET_CONFIRM_URL, json={"token": token, "new_password": "resetpassword789"})
    assert resp.status_code == 204, resp.text

    assert (await other.get(_ME_URL)).status_code == 401
    await other.aclose()

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert all(s.revoked_at is not None for s in sessions)


async def test_register_normalizes_email(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "Mixed@Example.COM ", "password": "password123", "display_name": "M"},
    )
    assert resp.status_code == 201
    assert resp.json()["email"] == "mixed@example.com"


async def test_login_is_case_insensitive(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "Case@Example.com", "password": "mypassword", "display_name": "C"},
    )
    token = app.state.email_verification_tokens["case@example.com"]
    await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})

    resp = await db_client.post(_LOGIN_URL, json={"email": "CASE@example.COM", "password": "mypassword"})
    assert resp.status_code == 200


async def test_register_rejects_case_variant_duplicate(db_client: AsyncClient) -> None:
    payload = {"email": "dupe@example.com", "password": "password123", "display_name": "D"}
    assert (await db_client.post(_REGISTER_URL, json=payload)).status_code == 201
    variant = {"email": "Dupe@Example.com", "password": "password123", "display_name": "D2"}
    assert (await db_client.post(_REGISTER_URL, json=variant)).status_code == 409


async def test_password_reset_request_is_case_insensitive(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "reset-ci@example.com", "password": "oldpassword", "display_name": "R"},
    )
    resp = await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "Reset-CI@Example.com"})
    assert resp.status_code == 204
    assert "reset-ci@example.com" in app.state.password_reset_tokens


async def test_email_uniqueness_is_case_insensitive_at_db(db_session: AsyncSession) -> None:
    db_session.add(User(email="dbcase@example.com", password_hash="x", display_name="A"))
    await db_session.flush()
    db_session.add(User(email="DBCase@Example.com", password_hash="x", display_name="B"))
    with pytest.raises(IntegrityError):
        await db_session.flush()
