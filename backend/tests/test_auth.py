from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException, Response
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import dependencies
from app.auth.hashing import _DUMMY_HASH
from app.auth.tokens import create_opaque_token, hash_token
from app.main import app
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from app.models.session import UserSession
from app.models.user import User
from app.routers import auth as auth_router
from tests.helpers import CSRF, create_dashboard, register_client, set_csrf

_REGISTER_URL = "/api/auth/register"
_LOGIN_URL = "/api/auth/login"
_VERIFY_EMAIL_URL = "/api/auth/verify-email"
_RESEND_VERIFICATION_URL = "/api/auth/resend-verification"
_PASSWORD_RESET_REQUEST_URL = "/api/auth/password-reset/request"
_PASSWORD_RESET_CONFIRM_URL = "/api/auth/password-reset/confirm"
_PASSWORD_RESET_CHECK_URL = "/api/auth/password-reset/check"
_REFRESH_URL = "/api/auth/refresh"
_LOGOUT_URL = "/api/auth/logout"
_ME_URL = "/api/auth/me"
_PROFILE_URL = "/api/auth/profile"
_PASSWORD_URL = "/api/auth/password"
_PREFERENCES_URL = "/api/auth/preferences"


def test_the_session_cookie_is_unguessable() -> None:
    """Entropy is what matters for an opaque credential.

    There is no signed token to skew, so expiry arithmetic is not the property under test.
    """
    raw, token_hash = create_opaque_token()

    assert len(bytes.fromhex(raw)) == 32
    assert token_hash == hash_token(raw)
    assert raw != create_opaque_token()[0]


async def test_register(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "new@example.com", "password": "password123", "display_name": "New User"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["email"] == "new@example.com"
    assert "session" not in resp.cookies
    assert "csrf_token" not in resp.cookies
    assert app.state.email_verification_tokens["new@example.com"]


async def test_register_duplicate_email_is_indistinguishable_from_a_new_signup(db_client: AsyncClient, db_session: AsyncSession) -> None:
    payload = {"email": "dup@example.com", "password": "password123", "display_name": "Dup"}
    first = await db_client.post(_REGISTER_URL, json=payload)
    assert first.status_code == 201

    app.state.email_verification_tokens.clear()
    second = await db_client.post(_REGISTER_URL, json=payload)

    # Byte-identical to the first-time response: registration is open to the internet, so anything
    # that distinguished these two would be a free account-existence oracle.
    assert (second.status_code, second.json()) == (first.status_code, first.json())

    # Nothing was created, and no verification link went out that a squatter could follow.
    assert app.state.email_verification_tokens == {}
    count = await db_session.scalar(select(func.count()).select_from(User).where(User.email == "dup@example.com"))
    assert count == 1

    # The address owner is the one party entitled to know, and is told out of band.
    assert app.state.existing_account_emails == ["dup@example.com"]


async def test_register_duplicate_still_pays_for_a_password_hash(db_client: AsyncClient, monkeypatch) -> None:
    payload = {"email": "timing@example.com", "password": "password123", "display_name": "T"}
    assert (await db_client.post(_REGISTER_URL, json=payload)).status_code == 201

    calls = 0
    real_hash = auth_router.hash_password

    async def counting_hash(password: str) -> str:
        nonlocal calls
        calls += 1
        return await real_hash(password)

    monkeypatch.setattr("app.routers.auth.hash_password", counting_hash)
    assert (await db_client.post(_REGISTER_URL, json=payload)).status_code == 201

    # Returning early without hashing would reopen through timing what the identical response closes.
    assert calls == 1


async def test_register_case_variant_collision_does_not_leak(db_client: AsyncClient, db_session: AsyncSession) -> None:
    # A mixed-case row inserted directly (bypassing schema normalization) is missed by register's
    # exact-match pre-check but caught by the lower(email) unique index — the IntegrityError backstop.
    db_session.add(User(email="Edge@Example.com", password_hash="x", display_name="Edge"))
    await db_session.flush()

    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "edge@example.com", "password": "password123", "display_name": "Edge2"},
    )
    # The backstop must absorb into the same success shape, not surface the collision as a 409.
    assert resp.status_code == 201
    assert resp.json() == {"email": "edge@example.com"}
    assert app.state.existing_account_emails == ["edge@example.com"]


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
    assert "session" in resp.cookies
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
    assert "session" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_verify_email_rejects_consumed_token_replay(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "replay@example.com", "password": "mypassword", "display_name": "Replay"},
    )
    token = app.state.email_verification_tokens["replay@example.com"]

    first = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert first.status_code == 200
    assert "session" in first.cookies

    replay = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert replay.status_code == 409
    assert replay.json()["detail"] == "Email already verified. Please sign in."
    assert "session" not in replay.cookies
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


async def test_check_reports_a_live_reset_token_without_spending_it(db_client: AsyncClient) -> None:
    """The page asks before it offers a form, so the check must not consume what it reports on."""
    await db_client.post(
        _REGISTER_URL,
        json={"email": "check-reset@example.com", "password": "oldpassword", "display_name": "Check"},
    )
    await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "check-reset@example.com"})
    reset_token = app.state.password_reset_tokens["check-reset@example.com"]

    first = await db_client.post(_PASSWORD_RESET_CHECK_URL, json={"token": reset_token})
    assert first.status_code == 200
    assert first.json() == {"valid": True}

    # Still spendable: a check that consumed the token would break the link it just validated.
    assert (await db_client.post(_PASSWORD_RESET_CHECK_URL, json={"token": reset_token})).json() == {"valid": True}
    confirm = await db_client.post(
        _PASSWORD_RESET_CONFIRM_URL,
        json={"token": reset_token, "new_password": "newpassword123"},
    )
    assert confirm.status_code == 204


async def test_check_reports_unusable_reset_tokens(db_client: AsyncClient, db_session: AsyncSession) -> None:
    """Unknown, expired and already-spent all read the same to the caller.

    The page shows one message for all three; distinguishing them would leak which tokens exist.
    """
    unknown = await db_client.post(_PASSWORD_RESET_CHECK_URL, json={"token": "not-a-real-token"})
    assert unknown.json() == {"valid": False}

    await db_client.post(
        _REGISTER_URL,
        json={"email": "stale-reset@example.com", "password": "oldpassword", "display_name": "Stale"},
    )
    await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "stale-reset@example.com"})
    reset_token = app.state.password_reset_tokens["stale-reset@example.com"]

    result = await db_session.execute(select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(reset_token)))
    record = result.scalar_one()
    record.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.commit()

    assert (await db_client.post(_PASSWORD_RESET_CHECK_URL, json={"token": reset_token})).json() == {"valid": False}


async def test_me_requires_auth(client: AsyncClient) -> None:
    resp = await client.get(_ME_URL)
    assert resp.status_code == 401


async def test_me_authenticated(auth_client: AsyncClient) -> None:
    resp = await auth_client.get(_ME_URL)
    assert resp.status_code == 200
    assert resp.json()["email"] == "testuser@example.com"


async def test_there_is_no_refresh_endpoint(auth_client: AsyncClient) -> None:
    """The refresh endpoint is gone, not merely unused.

    Its mandatory round trip was what a deploy or proxy 502 landed on, so a client still calling
    it would be relying on behaviour the server no longer has.
    """
    set_csrf(auth_client)
    assert (await auth_client.post(_REFRESH_URL)).status_code == 404


async def test_the_session_cookie_survives_ordinary_use(auth_client: AsyncClient) -> None:
    """Nothing rotates the session cookie.

    A cookie that changed under the client on every refresh turned a lost response into a
    "replay".
    """
    before = auth_client.cookies.get("session")
    assert before is not None

    assert (await auth_client.get(_ME_URL)).status_code == 200
    assert (await auth_client.get(_ME_URL)).status_code == 200

    assert auth_client.cookies.get("session") == before


async def test_logout(auth_client: AsyncClient) -> None:
    csrf = auth_client.cookies.get("csrf_token")
    assert csrf is not None
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 204


async def test_a_matching_origin_is_accepted(auth_client: AsyncClient) -> None:
    csrf = auth_client.cookies.get(auth_router.settings.csrf_cookie_name)
    assert csrf is not None
    resp = await auth_client.post(
        _LOGOUT_URL,
        headers={"X-CSRF-Token": csrf, "Origin": auth_router.settings.frontend_base_url},
    )
    assert resp.status_code == 204


async def test_a_foreign_origin_is_rejected_even_with_a_valid_token_pair(auth_client: AsyncClient) -> None:
    """A valid token pair does not rescue a foreign `Origin`.

    `Origin` is a forbidden header, so a cross-site caller cannot set it — which makes this the
    check that does not depend on cookie state staying in sync.
    """
    csrf = auth_client.cookies.get(auth_router.settings.csrf_cookie_name)
    assert csrf is not None
    resp = await auth_client.post(
        _LOGOUT_URL,
        headers={"X-CSRF-Token": csrf, "Origin": "https://evil.example"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Cross-origin request rejected"


async def test_cors_origins_widens_the_allowlist(auth_client: AsyncClient, monkeypatch) -> None:
    """CORS_ORIGINS widens the allowlist for a dev server reached over the LAN.

    `vite --host` makes the browser send its LAN address as `Origin`, which is not
    `frontend_base_url`. Pinned here so the documented remedy cannot quietly stop working.
    """
    lan_origin = "http://192.168.1.50:5173"
    monkeypatch.setattr(dependencies, "_ALLOWED_ORIGINS", frozenset({lan_origin}))

    csrf = auth_client.cookies.get(auth_router.settings.csrf_cookie_name)
    assert csrf is not None
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf, "Origin": lan_origin})

    assert resp.status_code == 204


async def test_a_missing_origin_falls_back_to_the_token_pair(auth_client: AsyncClient) -> None:
    """The `Origin` check is additive, not a replacement.

    A client sending no `Origin` must still work if its double-submit is good, or enabling the
    check would lock out anyone whose browser omits the header.
    """
    csrf = auth_client.cookies.get(auth_router.settings.csrf_cookie_name)
    assert csrf is not None
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 204


async def test_a_missing_origin_does_not_excuse_a_bad_token_pair(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": "wrong"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "CSRF token invalid"


def test_clearing_prefixed_cookies_keeps_them_secure(monkeypatch) -> None:
    """A `__Host-` cookie must carry Secure even to delete it.

    Without it the browser rejects the deletion for an invalid prefix and keeps the cookie. The
    monkeypatch is the only way this file reaches that configuration.
    """
    monkeypatch.setattr(auth_router, "_SECURE", True)
    response = Response()

    auth_router._clear_auth_cookies(response)

    # Keyed by cookie name, not by the `__Host-` prefix: this file runs under
    # `environment=development`, so a prefix-keyed assertion would match nothing and pass.
    cleared = {header.split("=", 1)[0]: header for header in response.headers.getlist("set-cookie")}
    for name in (auth_router.settings.session_cookie_name, auth_router.settings.csrf_cookie_name):
        assert "Secure" in cleared[name], cleared[name]


async def test_logout_requires_csrf(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_LOGOUT_URL)
    assert resp.status_code == 403


async def test_logout_wrong_csrf(auth_client: AsyncClient) -> None:
    resp = await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": "wrong"})
    assert resp.status_code == 403


async def test_the_session_cookie_is_dead_after_logout(auth_client: AsyncClient) -> None:
    """Logout revokes the row, so a retained cookie is inert.

    Asserted through a request rather than the response's Set-Cookie: clearing the cookie is
    cosmetic, revoking the row is what ends the session.
    """
    csrf = auth_client.cookies.get("csrf_token")
    assert csrf is not None
    session_cookie = auth_client.cookies.get("session")
    assert session_cookie is not None

    await auth_client.post(_LOGOUT_URL, headers={"X-CSRF-Token": csrf})

    auth_client.cookies.set("session", session_cookie)
    assert (await auth_client.get(_ME_URL)).status_code == 401


async def test_update_profile(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PROFILE_URL,
        json={"display_name": "Updated User"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "Updated User"
    # No cookie work — the session cookie carries no identity to re-issue.
    assert "session" not in resp.cookies

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


async def test_profile_and_preferences_reject_empty_or_unknown_patches(auth_client: AsyncClient) -> None:
    for url, payload in (
        (_PROFILE_URL, {}),
        (_PROFILE_URL, {"display_nam": "Typo"}),
        (_PREFERENCES_URL, {}),
        (_PREFERENCES_URL, {"home_dashbord_id": None}),
    ):
        set_csrf(auth_client)
        response = await auth_client.patch(url, json=payload)
        assert response.status_code == 422


async def test_any_request_slides_the_session_idle_clock(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Reading is enough to keep a session alive.

    The auth dependency owns the idle clock; bumped per route instead, a user who merely read
    would idle out mid-use.
    """
    session = (await db_session.execute(select(UserSession))).scalars().one()
    old = datetime.now(UTC) - timedelta(hours=1)
    session.last_used_at = old
    await db_session.flush()

    assert (await auth_client.get(_ME_URL)).status_code == 200

    await db_session.refresh(session)
    assert session.last_used_at > old


async def test_the_idle_slide_is_committed(auth_client: AsyncClient, db_session: AsyncSession, monkeypatch) -> None:
    """The slide must be committed, not merely applied.

    The test above cannot prove durability: the route shares this session, so an uncommitted
    UPDATE is visible either way. A GET route never commits, so without one the slide rolls back
    and a read-only user idles out mid-use — assert the mechanism, not the result.
    """
    session = (await db_session.execute(select(UserSession))).scalars().one()
    session.last_used_at = datetime.now(UTC) - timedelta(hours=1)
    await db_session.flush()

    commits = 0
    real_commit = db_session.commit

    async def counting_commit() -> None:
        nonlocal commits
        commits += 1
        await real_commit()

    monkeypatch.setattr(db_session, "commit", counting_commit)

    assert (await auth_client.get(_ME_URL)).status_code == 200

    assert commits == 1, "the auth dependency must commit the slide; a GET route never will"


async def test_a_freshly_used_session_costs_no_write(auth_client: AsyncClient, db_session: AsyncSession, monkeypatch) -> None:
    """The throttle at request level.

    Back-to-back reads must not each pay for an UPDATE plus a COMMIT.
    """
    commits = 0
    real_commit = db_session.commit

    async def counting_commit() -> None:
        nonlocal commits
        commits += 1
        await real_commit()

    monkeypatch.setattr(db_session, "commit", counting_commit)

    assert (await auth_client.get(_ME_URL)).status_code == 200
    assert (await auth_client.get(_ME_URL)).status_code == 200

    assert commits == 0


async def test_change_password_updates_login_credentials(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PASSWORD_URL,
        json={"current_password": "testpassword123", "new_password": "betterpassword456"},
    )
    assert resp.status_code == 204
    # The calling session is kept as-is — see the note on `change_password`.
    assert "session" not in resp.cookies

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


async def test_the_session_cookie_hashes_to_a_real_session_row(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """The cookie is the whole credential.

    It carries no claims, so the only thing tying it to an identity is its hash on a live row.
    """
    session = (await db_session.execute(select(UserSession))).scalars().one()
    assert session.revoked_at is None

    assert hash_token(auth_client.cookies["session"]) == session.token_hash


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
    """A password change contains the damage without signing you out where you stand."""
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


async def test_logout_revokes_the_calling_session(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Logout revokes exactly the session that authenticated the request.

    It reads the session from that cookie, so it can never no-op.
    """
    set_csrf(auth_client)

    resp = await auth_client.post(_LOGOUT_URL)
    assert resp.status_code == 204

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert sessions, "the session row still exists"
    assert all(s.revoked_at is not None for s in sessions), "the current session was revoked"


async def test_password_reset_revokes_every_session(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """A password reset revokes everything.

    The flow is unauthenticated, so unlike a password change there is no caller session to spare.
    """
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


async def test_register_case_variant_duplicate_creates_nothing(db_client: AsyncClient, db_session: AsyncSession) -> None:
    payload = {"email": "dupe@example.com", "password": "password123", "display_name": "D"}
    assert (await db_client.post(_REGISTER_URL, json=payload)).status_code == 201
    variant = {"email": "Dupe@Example.com", "password": "password123", "display_name": "D2"}
    assert (await db_client.post(_REGISTER_URL, json=variant)).status_code == 201

    # Normalization means the variant hits the same account — it must not become a second one.
    count = await db_session.scalar(select(func.count()).select_from(User).where(User.email == "dupe@example.com"))
    assert count == 1


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


async def test_create_session_refuses_an_unverified_user(db_session: AsyncSession) -> None:
    """The verification gate holds at the choke point, not only inside `login`.

    `_create_session` is the one path to a `UserSession` (it is the only caller of `start_session`,
    which is the only place `UserSession` is instantiated). Today its two callers each remember to
    check verification themselves — `login` returns 403 before spending an Argon2 verify, and
    `verify_email` sets `email_verified_at` immediately before calling. That invariant should not
    depend on every future caller remembering, so the helper refuses on its own.
    """
    user = User(
        email="choke-point@example.com",
        password_hash="x",
        display_name="Choke",
        email_verified_at=None,
    )
    db_session.add(user)
    await db_session.flush()

    with pytest.raises(HTTPException) as excinfo:
        await auth_router._create_session(user, Response(), db_session)

    assert excinfo.value.status_code == 403
    sessions = await db_session.execute(select(func.count()).select_from(UserSession).where(UserSession.user_id == user.id))
    assert sessions.scalar_one() == 0
