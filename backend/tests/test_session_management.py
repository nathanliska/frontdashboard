"""Session management must never enumerate or revoke another account's sign-ins."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.services.sessions import resolve_session, start_session
from tests.helpers import make_db_user, set_csrf


async def test_session_list_exposes_only_live_owned_metadata(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session)
    stranger = await make_db_user(db_session)
    current, raw = await start_session(owner.id, db_session)
    other, _ = await start_session(owner.id, db_session)
    expired, _ = await start_session(owner.id, db_session)
    idle, _ = await start_session(owner.id, db_session)
    revoked, _ = await start_session(owner.id, db_session)
    await start_session(stranger.id, db_session)
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    idle.last_used_at = datetime.now(UTC) - timedelta(days=settings.session_idle_days, seconds=1)
    revoked.revoked_at = datetime.now(UTC)
    await db_session.flush()
    client.cookies.set(settings.session_cookie_name, raw)
    response = await client.get("/api/auth/sessions")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    rows = {row["id"]: row for row in response.json()["items"]}
    assert set(rows) == {str(current.id), str(other.id)}
    assert rows[str(current.id)]["is_current"] is True
    assert rows[str(other.id)]["is_current"] is False
    assert set(rows[str(current.id)]) == {"id", "created_at", "last_used_at", "expires_at", "is_current"}
    assert raw not in response.text


async def test_revocation_is_owned_csrf_protected_and_effective(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session)
    stranger = await make_db_user(db_session)
    current, raw = await start_session(owner.id, db_session)
    other, other_raw = await start_session(owner.id, db_session)
    foreign, foreign_raw = await start_session(stranger.id, db_session)
    client.cookies.set(settings.session_cookie_name, raw)
    assert (await client.delete(f"/api/auth/sessions/{other.id}")).status_code == 403
    set_csrf(client)
    for target in (foreign.id, uuid.uuid4()):
        response = await client.delete(f"/api/auth/sessions/{target}")
        assert response.status_code == 404
        assert response.json() == {"detail": "Session not found"}
    assert (await client.delete(f"/api/auth/sessions/{current.id}")).status_code == 422
    assert (await client.delete(f"/api/auth/sessions/{other.id}")).status_code == 204
    assert await resolve_session(other_raw, db_session) is None
    assert await resolve_session(raw, db_session) is not None
    assert await resolve_session(foreign_raw, db_session) is not None
    assert (await client.delete(f"/api/auth/sessions/{other.id}")).status_code == 204


async def test_session_cursor_survives_revoking_the_boundary_row(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session)
    current, raw = await start_session(owner.id, db_session)
    timestamp = datetime.now(UTC)
    current.created_at = timestamp + timedelta(seconds=1)
    for _ in range(51):
        session, _ = await start_session(owner.id, db_session)
        session.created_at = timestamp
    await db_session.flush()
    client.cookies.set(settings.session_cookie_name, raw)
    set_csrf(client)
    first = (await client.get("/api/auth/sessions")).json()
    assert len(first["items"]) == 50
    cursor = first["next_cursor"]
    assert cursor is not None
    assert (await client.delete(f"/api/auth/sessions/{cursor['id']}")).status_code == 204
    second = (await client.get("/api/auth/sessions", params={"before": cursor["created_at"], "before_id": cursor["id"]})).json()
    assert len(second["items"]) == 2
    assert second["next_cursor"] is None
    assert not ({row["id"] for row in first["items"]} & {row["id"] for row in second["items"]})


@pytest.mark.parametrize(
    "params", [{"before": "2026-09-01T00:00:00Z"}, {"before_id": str(uuid.uuid4())}, {"before": "2026-09-01", "before_id": str(uuid.uuid4())}]
)
async def test_session_cursor_rejects_partial_or_naive_values(client: AsyncClient, db_session: AsyncSession, params: dict[str, str]) -> None:
    owner = await make_db_user(db_session)
    _, raw = await start_session(owner.id, db_session)
    client.cookies.set(settings.session_cookie_name, raw)
    assert (await client.get("/api/auth/sessions", params=params)).status_code == 422
