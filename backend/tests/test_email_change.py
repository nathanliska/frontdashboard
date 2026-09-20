"""Changing an account's address: confirmed from the new one, announced to the old one."""

import asyncio
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token
from app.main import app
from app.models.email_change_token import EmailChangeToken
from app.models.password_reset_token import PasswordResetToken
from app.models.user import User
from app.routers import auth as auth_router
from app.services.accounts import _ACCOUNT_LOCK_NAMESPACE
from app.services.email_change import confirm_email_change, void_email_changes
from app.services.password_reset import consume_password_reset_token
from tests.helpers import MemberFactory, current_user

_OLD = "testuser@example.com"
_NEW = "renamed@example.com"
_PASSWORD = "testpassword123"
# Phrases the common-password screen lets through; named so a scanner does not read them as keys.
_SECOND = "otter-lantern-quilt-42"
_THIRD = "heron-velvet-anchor-17"


@pytest.fixture
async def stranger(auth_client: AsyncClient) -> AsyncGenerator[AsyncClient]:
    """A signed-out caller, as the link opened on another device would be."""
    del auth_client
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as fresh:
        yield fresh


async def _request(client: AsyncClient, new_email: str = _NEW, password: str = _PASSWORD) -> int:
    return (await client.post("/api/auth/email-change", json={"new_email": new_email, "password": password})).status_code


async def _confirm(client: AsyncClient, token: str) -> int:
    return (await client.post("/api/auth/email-change/confirm", json={"token": token})).status_code


async def test_the_address_switches_only_once_the_new_one_confirms(auth_client: AsyncClient, stranger: AsyncClient) -> None:
    assert await _request(auth_client) == 204
    assert (await current_user(auth_client))["email"] == _OLD
    assert app.state.email_change_notices == [(_OLD, _NEW)]

    # Confirmed signed-out, as from a phone: the mailed token is the proof, and it signs no one in.
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 204
    assert (await stranger.get("/api/auth/me")).status_code == 401
    assert (await current_user(auth_client))["email"] == _NEW
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 400

    assert (await stranger.post("/api/auth/login", json={"email": _OLD, "password": _PASSWORD})).status_code == 401
    assert (await stranger.post("/api/auth/login", json={"email": _NEW, "password": _PASSWORD})).status_code == 200


async def test_a_wrong_password_is_refused_without_signing_the_person_out(auth_client: AsyncClient) -> None:
    assert await _request(auth_client, password="not-the-password") == 403
    assert app.state.email_change_tokens == {}
    assert (await auth_client.get("/api/auth/me")).status_code == 200


async def test_a_taken_address_looks_the_same_to_the_requester_and_is_never_mailed(
    auth_client: AsyncClient, accounts: MemberFactory, db_session: AsyncSession
) -> None:
    """The requester reads the current inbox, so the warning and the stored token must not depend on it."""
    await accounts("taken@example.com")
    assert await _request(auth_client, new_email="Taken@Example.com") == 204
    assert await _request(auth_client, new_email=_OLD) == 204

    assert app.state.email_change_tokens == {}
    assert app.state.email_change_notices == [(_OLD, "taken@example.com"), (_OLD, _OLD)]
    stored = (await db_session.execute(select(EmailChangeToken.new_email).order_by(EmailChangeToken.created_at))).scalars().all()
    assert stored == ["taken@example.com", _OLD]


async def test_an_expired_link_is_dead_and_deleting_the_account_takes_the_pending_change(
    auth_client: AsyncClient, stranger: AsyncClient, db_session: AsyncSession
) -> None:
    assert await _request(auth_client) == 204
    token = (await db_session.execute(select(EmailChangeToken))).scalar_one()
    token.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.flush()
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 400

    # The user row is never removed, so the foreign key's cascade never fires for a deletion.
    assert (await auth_client.request("DELETE", "/api/auth/account", json={"password": _PASSWORD})).status_code == 204
    assert (await db_session.execute(select(EmailChangeToken))).scalars().all() == []


async def test_a_newer_request_replaces_the_older_link(auth_client: AsyncClient, stranger: AsyncClient) -> None:
    assert await _request(auth_client, new_email="first@example.com") == 204
    assert await _request(auth_client, new_email=_NEW) == 204
    assert await _confirm(stranger, app.state.email_change_tokens["first@example.com"]) == 400
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 204


async def test_changing_or_resetting_the_password_cancels_a_pending_change(auth_client: AsyncClient, stranger: AsyncClient) -> None:
    """What the notice to the old address tells its owner to do has to actually stop the change."""
    assert await _request(auth_client) == 204
    changed = await auth_client.patch("/api/auth/password", json={"current_password": _PASSWORD, "new_password": _SECOND})
    assert changed.status_code == 204, changed.text
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 400

    assert await _request(auth_client, password=_SECOND) == 204
    assert (await stranger.post("/api/auth/password-reset/request", json={"email": _OLD})).status_code == 204
    reset = {"token": app.state.password_reset_tokens[_OLD], "new_password": _THIRD}
    assert (await stranger.post("/api/auth/password-reset/confirm", json=reset)).status_code == 204
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 400


async def test_confirming_voids_reset_links_already_mailed_to_the_old_address(auth_client: AsyncClient, stranger: AsyncClient) -> None:
    assert (await stranger.post("/api/auth/password-reset/request", json={"email": _OLD})).status_code == 204
    assert await _request(auth_client) == 204
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 204
    stale = {"token": app.state.password_reset_tokens[_OLD], "new_password": _THIRD}
    assert (await stranger.post("/api/auth/password-reset/confirm", json=stale)).status_code == 400


async def test_an_address_registered_after_the_link_was_sent_kills_the_link(
    auth_client: AsyncClient, stranger: AsyncClient, accounts: MemberFactory
) -> None:
    assert await _request(auth_client) == 204
    await accounts(_NEW)
    assert await _confirm(stranger, app.state.email_change_tokens[_NEW]) == 400
    assert (await current_user(auth_client))["email"] == _OLD


async def test_a_link_for_an_account_deleted_in_the_meantime_renames_nothing(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Deletion sweeps the token, so only a confirm racing it gets here; it must not re-address the tombstone."""
    assert await _request(auth_client) == 204
    user = (await db_session.execute(select(User).where(User.email == _OLD))).scalar_one()
    user.deleted_at = datetime.now(UTC)
    await db_session.flush()

    assert await confirm_email_change(app.state.email_change_tokens[_NEW], db_session) is False
    await db_session.refresh(user)
    assert user.email == _OLD


async def _pending(db: AsyncSession, user_id: uuid.UUID, new_email: str) -> str:
    raw, token_hash = create_opaque_token()
    db.add(EmailChangeToken(user_id=user_id, new_email=new_email, token_hash=token_hash, expires_at=datetime.now(UTC) + timedelta(hours=1)))
    await db.commit()
    return raw


async def _someone_waits_on_a_lock(observer: AsyncSession) -> bool:
    for _ in range(50):
        await observer.execute(text("SELECT pg_stat_clear_snapshot()"))
        if await observer.scalar(text("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")):
            return True
        await asyncio.sleep(0.1)
    return False


async def test_two_confirms_of_one_link_switch_the_address_once(concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID]) -> None:
    first, second, user_id = concurrent_sessions
    token = await _pending(first, user_id, f"once-{user_id}@example.com")

    assert await confirm_email_change(token, first) is True
    loser = asyncio.create_task(confirm_email_change(token, second))
    try:
        assert await _someone_waits_on_a_lock(first)
        await first.commit()
        assert await loser is False
    finally:
        await first.rollback()
        await asyncio.wait({loser})
        await second.rollback()


async def test_a_confirm_and_a_reset_take_their_tokens_in_one_order(concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID]) -> None:
    """A reset holds its token and then voids the change; a confirm taking them the other way round deadlocks."""
    first, second, user_id = concurrent_sessions
    change = await _pending(first, user_id, f"order-{user_id}@example.com")
    raw_reset, reset_hash = create_opaque_token()
    first.add(PasswordResetToken(user_id=user_id, token_hash=reset_hash, expires_at=datetime.now(UTC) + timedelta(hours=1)))
    await first.commit()

    assert await consume_password_reset_token(raw_reset, first) == user_id
    confirming = asyncio.create_task(confirm_email_change(change, second))
    try:
        assert await _someone_waits_on_a_lock(first)
        await void_email_changes(user_id, first)
        await first.commit()
        assert await confirming is False
    finally:
        await first.rollback()
        await asyncio.wait({confirming})
        await second.rollback()
    email = (await second.execute(select(User.email).where(User.id == user_id))).scalar_one()
    assert email == f"race-{user_id}@example.com"


async def test_a_reset_requested_while_the_address_is_changing_waits_and_mails_nothing(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID], stranger: AsyncClient
) -> None:
    """Unserialised, the link lands in the old inbox after its reset links were voided, and outlives the change."""
    # Requested first so it tears down last, after the savepoint the request ran in.
    first, _, user_id = concurrent_sessions
    old = f"race-{user_id}@example.com"
    token = await _pending(first, user_id, f"moved-{user_id}@example.com")

    assert await confirm_email_change(token, first) is True
    asking = asyncio.create_task(stranger.post("/api/auth/password-reset/request", json={"email": old}))
    try:
        assert await _someone_waits_on_a_lock(first)
        await first.commit()
    finally:
        await first.rollback()
        await asyncio.wait({asking})
    assert asking.result().status_code == 204
    # Nothing to either inbox: the address asked about no longer names an account.
    assert app.state.password_reset_tokens == {}


@pytest.mark.parametrize("route", ["email-change", "email-change/confirm", "password", "password-reset/request", "password-reset/confirm"])
async def test_every_path_that_moves_or_cancels_a_change_waits_on_the_account_lock(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
    auth_client: AsyncClient,
    stranger: AsyncClient,
    db_session: AsyncSession,
    route: str,
) -> None:
    """One lock, taken before any row: that is what lets a void and a request never interleave."""
    # Requested first so it tears down last; the lock is keyed on the id, so the row need not be visible.
    _, holding, _ = concurrent_sessions
    me = await current_user(auth_client)
    # Inserted, not requested: a route run here would take the lock in this test's own outer
    # transaction, which keeps it until teardown.
    change, change_hash = create_opaque_token()
    reset, reset_hash = create_opaque_token()
    expires_at = datetime.now(UTC) + timedelta(hours=1)
    db_session.add(EmailChangeToken(user_id=uuid.UUID(me["id"]), new_email=_NEW, token_hash=change_hash, expires_at=expires_at))
    db_session.add(PasswordResetToken(user_id=uuid.UUID(me["id"]), token_hash=reset_hash, expires_at=expires_at))
    await db_session.flush()
    calls = {
        "email-change": lambda: auth_client.post("/api/auth/email-change", json={"new_email": "third@example.com", "password": _PASSWORD}),
        "email-change/confirm": lambda: stranger.post("/api/auth/email-change/confirm", json={"token": change}),
        "password": lambda: auth_client.patch("/api/auth/password", json={"current_password": _PASSWORD, "new_password": _SECOND}),
        "password-reset/request": lambda: stranger.post("/api/auth/password-reset/request", json={"email": _OLD}),
        "password-reset/confirm": lambda: stranger.post("/api/auth/password-reset/confirm", json={"token": reset, "new_password": _SECOND}),
    }

    await holding.execute(text("SET LOCAL lock_timeout = '5s'"))
    await holding.execute(select(func.pg_advisory_xact_lock(_ACCOUNT_LOCK_NAMESPACE, func.hashtext(me["id"]))))
    calling = asyncio.create_task(calls[route]())
    try:
        assert await _someone_waits_on_a_lock(holding)
        assert not calling.done()
    finally:
        await holding.rollback()
        await asyncio.wait({calling})
    assert calling.result().status_code == 204, calling.result().text


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("post", "/api/auth/email-change", {"new_email": _NEW, "password": _PASSWORD}),
        ("patch", "/api/auth/password", {"current_password": _PASSWORD, "new_password": _SECOND}),
    ],
)
async def test_an_account_deleted_while_the_request_waited_is_signed_out_not_crashed(
    auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch, method: str, path: str, body: dict[str, str]
) -> None:
    """The lock's re-read hands back the tombstone, and its hash is not one a verify can even parse."""

    async def gone(db: AsyncSession, user_id: uuid.UUID) -> None:
        return None

    monkeypatch.setattr(auth_router, "lock_live_user", gone)
    assert (await auth_client.request(method, path, json=body)).status_code == 401
