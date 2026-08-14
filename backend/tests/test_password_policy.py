"""Breached passwords are refused wherever one can be set, without leaking anything else."""

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from app.main import app
from app.services.passwords import COMMON_PASSWORDS, assert_password_not_common
from tests.helpers import set_csrf

_LISTED = "password123"
_STRONG = "chalk-viper-tundra-97"
_REGISTER_URL = "/api/auth/register"


def _registration(email: str, password: str) -> dict:
    return {"email": email, "password": password, "display_name": "Member"}


@pytest.mark.unit
def test_the_list_loaded_and_covers_what_attackers_spray() -> None:
    """A check that reads a data file has to fail loudly when the file is missing or empty."""
    assert len(COMMON_PASSWORDS) > 1000
    for sprayed in ("password123", "admin123", "qwerty123", "letmein1", "iloveyou1"):
        assert sprayed in COMMON_PASSWORDS, sprayed
    # Nothing below the 8-character minimum belongs here — it could never reach this check.
    assert not any(len(entry) < 8 for entry in COMMON_PASSWORDS)


@pytest.mark.unit
def test_the_check_is_case_insensitive_and_ignores_padding() -> None:
    for variant in (_LISTED, _LISTED.upper(), _LISTED.capitalize(), f" {_LISTED} "):
        with pytest.raises(HTTPException) as caught:
            assert_password_not_common(variant)
        assert caught.value.status_code == 422
    # A password that is not listed simply returns; the absence of a raise is the assertion.
    assert_password_not_common(_STRONG)


async def test_registration_refuses_a_breached_password(db_client: AsyncClient) -> None:
    resp = await db_client.post(_REGISTER_URL, json=_registration("weak@example.com", _LISTED))
    assert resp.status_code == 422
    assert "breached" in resp.json()["detail"]


async def test_registration_still_accepts_a_strong_password(db_client: AsyncClient) -> None:
    resp = await db_client.post(_REGISTER_URL, json=_registration("strong@example.com", _STRONG))
    assert resp.status_code == 201


async def test_the_refusal_cannot_be_used_to_probe_for_accounts(db_client: AsyncClient) -> None:
    """The answer must depend on the password alone, or it becomes an enumeration oracle.

    Registration answers identically for known and unknown addresses (ADR-011); a weak-password
    rejection that differed between them would reintroduce exactly what that design closes.
    """
    assert (await db_client.post(_REGISTER_URL, json=_registration("taken@example.com", _STRONG))).status_code == 201

    taken = await db_client.post(_REGISTER_URL, json=_registration("taken@example.com", _LISTED))
    fresh = await db_client.post(_REGISTER_URL, json=_registration("brand-new@example.com", _LISTED))

    assert taken.status_code == fresh.status_code == 422
    assert taken.json() == fresh.json()


async def test_changing_to_a_breached_password_is_refused(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(
        "/api/auth/password",
        json={"current_password": "testpassword123", "new_password": _LISTED},
    )
    assert resp.status_code == 422
    assert "breached" in resp.json()["detail"]


async def test_a_rejected_password_does_not_burn_the_reset_link(db_client: AsyncClient) -> None:
    """The refusal must not cost the user their one-time link.

    The screening runs before the token is spent, so this holds outright rather than by way of the
    422 rolling the consumption back — which would depend on session lifetime and would strand
    anyone who picked a weak password the moment a refactor committed earlier.
    """
    await db_client.post(_REGISTER_URL, json=_registration("reset-weak@example.com", _STRONG))
    verification = app.state.email_verification_tokens["reset-weak@example.com"]
    assert (await db_client.post("/api/auth/verify-email", json={"token": verification})).status_code == 200

    assert (await db_client.post("/api/auth/password-reset/request", json={"email": "reset-weak@example.com"})).status_code == 204
    token = app.state.password_reset_tokens["reset-weak@example.com"]

    refused = await db_client.post("/api/auth/password-reset/confirm", json={"token": token, "new_password": _LISTED})
    assert refused.status_code == 422

    # The same link still works once a better password is offered.
    accepted = await db_client.post("/api/auth/password-reset/confirm", json={"token": token, "new_password": "otter-lantern-quilt-42"})
    assert accepted.status_code == 204
