"""Tests for SSE infrastructure (Step 11).

Unit tests cover the SseManager directly (no DB needed).
Integration tests cover the /api/sse endpoint: auth guard, correct headers,
reconnect resync behavior.
"""

import json
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.routers.sse import _should_resync_on_connect
from app.sse.manager import SseManager

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CSRF = "test-csrf-token"


def _csrf(client: AsyncClient) -> None:
    client.cookies.set("csrf_token", CSRF)
    client.headers.update({"x-csrf-token": CSRF})


async def _register(client: AsyncClient, email: str = "alice@example.com", display_name: str = "Alice") -> dict:
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password123", "display_name": display_name},
    )
    assert resp.status_code == 201
    return resp.json()


# ---------------------------------------------------------------------------
# SseManager unit tests (no DB, no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manager_connect_disconnect() -> None:
    mgr = SseManager()
    g = uuid.uuid4()
    u = uuid.uuid4()

    client = mgr.connect(u, {g})
    assert len(mgr._clients) == 1

    mgr.disconnect(client)
    assert len(mgr._clients) == 0


@pytest.mark.asyncio
async def test_manager_disconnect_idempotent() -> None:
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), set())
    mgr.disconnect(client)
    mgr.disconnect(client)  # should not raise


@pytest.mark.asyncio
async def test_manager_broadcast_to_group_member() -> None:
    mgr = SseManager()
    group_id = uuid.uuid4()
    actor_id = uuid.uuid4()
    member_id = uuid.uuid4()

    member_client = mgr.connect(member_id, {group_id})
    outsider_client = mgr.connect(uuid.uuid4(), {uuid.uuid4()})

    msg = {"data": "hello", "event": "test"}
    await mgr.broadcast(msg, group_id=group_id, actor_id=actor_id)

    assert member_client.queue.qsize() == 1
    assert outsider_client.queue.qsize() == 0
    assert await member_client.queue.get() == msg


@pytest.mark.asyncio
async def test_manager_broadcast_private_only_to_actor() -> None:
    mgr = SseManager()
    actor_id = uuid.uuid4()
    other_id = uuid.uuid4()

    actor_client = mgr.connect(actor_id, set())
    other_client = mgr.connect(other_id, set())

    msg = {"data": "private", "event": "test"}
    await mgr.broadcast(msg, group_id=None, actor_id=actor_id)

    assert actor_client.queue.qsize() == 1
    assert other_client.queue.qsize() == 0


@pytest.mark.asyncio
async def test_manager_broadcast_targeted_users_reaches_non_actor() -> None:
    mgr = SseManager()
    actor_id = uuid.uuid4()
    target_id = uuid.uuid4()
    outsider_id = uuid.uuid4()

    actor_client = mgr.connect(actor_id, set())
    target_client = mgr.connect(target_id, set())
    outsider_client = mgr.connect(outsider_id, set())

    msg = {"data": "dashboard update", "event": "dashboard.updated"}
    await mgr.broadcast(msg, group_id=None, user_ids={actor_id, target_id}, actor_id=actor_id)

    assert actor_client.queue.qsize() == 1
    assert target_client.queue.qsize() == 1
    assert outsider_client.queue.qsize() == 0
    assert await target_client.queue.get() == msg


@pytest.mark.asyncio
async def test_manager_multiple_connections_same_user() -> None:
    """Two open tabs for the same user both receive group events."""
    mgr = SseManager()
    group_id = uuid.uuid4()
    user_id = uuid.uuid4()

    tab1 = mgr.connect(user_id, {group_id})
    tab2 = mgr.connect(user_id, {group_id})

    msg = {"data": "update", "event": "list.updated"}
    await mgr.broadcast(msg, group_id=group_id, actor_id=user_id)

    assert tab1.queue.qsize() == 1
    assert tab2.queue.qsize() == 1


# ---------------------------------------------------------------------------
# sse.py unit tests
# ---------------------------------------------------------------------------


def test_reconnect_with_last_event_id_resyncs() -> None:
    assert _should_resync_on_connect("123") is True


def test_initial_connect_without_last_event_id_skips_resync() -> None:
    assert _should_resync_on_connect(None) is False


# ---------------------------------------------------------------------------
# SSE endpoint integration tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sse_requires_auth(client: AsyncClient) -> None:
    resp = await client.get("/api/sse")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_activity_events_build_correct_sse_payloads(
    db_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Verify that activity events created by mutations can be serialized for SSE.

    We don't test the full SSE streaming pipeline because httpx's ASGI transport
    cannot cleanly close infinite SSE generators. Instead we verify that the
    activity events exist in the DB with the right type and can be serialized.
    """
    from sqlalchemy import select

    from app.models.activity import ActivityEvent
    from app.sse.events import activity_to_sse_dict

    await _register(db_client)

    _csrf(db_client)
    dash_resp = await db_client.post("/api/dashboards", json={"name": "SSE Test"})
    assert dash_resp.status_code == 201
    dashboard_id = dash_resp.json()["id"]

    _csrf(db_client)
    create_resp = await db_client.post("/api/lists", json={"name": "SSE Test List", "list_type": "checklist", "dashboard_id": dashboard_id})
    assert create_resp.status_code == 201

    # Verify the activity event exists and can be serialized for SSE
    result = await db_session.execute(select(ActivityEvent).where(ActivityEvent.event_id > 0).order_by(ActivityEvent.event_id))
    events = result.scalars().all()
    list_created_events = [e for e in events if str(e.event_type) == "list.created"]
    assert len(list_created_events) >= 1

    sse_dict = activity_to_sse_dict(list_created_events[0])
    payload = json.loads(sse_dict["data"])
    assert payload["event_type"] == "list.created"


def test_resync_dict_has_correct_event_type() -> None:
    """Verify the resync SSE message has the right structure."""
    from app.sse.events import resync_dict

    msg = resync_dict()
    assert msg["event"] == "resync"
    data = json.loads(msg["data"])
    assert data["reason"] == "refresh_required"


def test_connected_dict_primes_last_event_id() -> None:
    """Verify the lightweight connect event carries a stable SSE id."""
    from app.sse.events import connected_dict

    msg = connected_dict()
    assert msg["event"] == "connected"
    assert msg["id"] == "connected"
    data = json.loads(msg["data"])
    assert data == {}
