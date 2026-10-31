"""Throwaway-inbox addresses are refused wherever an account can take one, without leaking anything else."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.services.email_domains import is_disposable_email

_REGISTER_URL = "/api/auth/register"
_STRONG = "chalk-viper-tundra-97"


def _registration(email: str) -> dict:
    return {"email": email, "password": _STRONG, "display_name": "Member"}


@pytest.mark.unit
@pytest.mark.parametrize("email", ["a@mailinator.com", "a@yopmail.com", "a@guerrillamail.com", "a@inbox.mailinator.com", "a@雨云.com"])
def test_throwaway_domains_and_their_subdomains_are_listed(email: str) -> None:
    assert is_disposable_email(email)


@pytest.mark.unit
@pytest.mark.parametrize(
    "email",
    # Privacy relays are permanent inboxes; refusing them would turn away the careful, not the abusive.
    ["a@gmail.com", "a@proton.me", "a@simplelogin.com", "a@addy.io", "a@mozmail.com", "a@duck.com", "a@privaterelay.appleid.com"],
)
def test_permanent_inboxes_and_privacy_relays_are_not(email: str) -> None:
    assert not is_disposable_email(email)


async def test_registration_refuses_a_disposable_address(db_client: AsyncClient) -> None:
    resp = await db_client.post(_REGISTER_URL, json=_registration("someone@mailinator.com"))
    assert resp.status_code == 422
    assert "Disposable" in resp.json()["detail"]


async def test_the_refusal_cannot_be_used_to_probe_for_accounts(db_client: AsyncClient, db_session: AsyncSession) -> None:
    """A listed domain answers the same whether or not the address has an account (ADR-011).

    Accounts registered before the rule keep their addresses, so a taken one can exist.
    """
    db_session.add(User(email="taken@mailinator.com", password_hash="unused", display_name="Earlier"))
    await db_session.commit()

    taken = await db_client.post(_REGISTER_URL, json=_registration("taken@mailinator.com"))
    fresh = await db_client.post(_REGISTER_URL, json=_registration("fresh@mailinator.com"))
    assert taken.status_code == fresh.status_code == 422
    assert taken.json() == fresh.json()


async def test_changing_to_a_disposable_address_is_refused(auth_client: AsyncClient) -> None:
    """Registration alone is a door with a side entrance: sign up with a real inbox, then switch."""
    resp = await auth_client.post("/api/auth/email-change", json={"new_email": "later@yopmail.com", "password": "testpassword123"})
    assert resp.status_code == 422
    assert "Disposable" in resp.json()["detail"]
