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

from app.main import app
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
    token = app.state.email_verification_tokens[email]
    verify_resp = await client.post("/api/auth/verify-email", json={"token": token})
    assert verify_resp.status_code == 200
    return verify_resp.json()


# ---------------------------------------------------------------------------
# SseManager unit tests (no DB, no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manager_connect_disconnect() -> None:
    mgr = SseManager()
    u = uuid.uuid4()

    client = mgr.connect(u)
    assert len(mgr._clients) == 1

    mgr.disconnect(client)
    assert len(mgr._clients) == 0


@pytest.mark.asyncio
async def test_manager_disconnect_idempotent() -> None:
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())
    mgr.disconnect(client)
    mgr.disconnect(client)  # should not raise


@pytest.mark.asyncio
async def test_manager_broadcast_private_only_to_actor() -> None:
    mgr = SseManager()
    actor_id = uuid.uuid4()
    other_id = uuid.uuid4()

    actor_client = mgr.connect(actor_id)
    other_client = mgr.connect(other_id)

    msg = {"data": "private", "event": "test"}
    await mgr.broadcast(msg, actor_id=actor_id)

    assert actor_client.queue.qsize() == 1
    assert other_client.queue.qsize() == 0


@pytest.mark.asyncio
async def test_manager_broadcast_targeted_users_reaches_non_actor() -> None:
    mgr = SseManager()
    actor_id = uuid.uuid4()
    target_id = uuid.uuid4()
    outsider_id = uuid.uuid4()

    actor_client = mgr.connect(actor_id)
    target_client = mgr.connect(target_id)
    outsider_client = mgr.connect(outsider_id)

    msg = {"data": "dashboard update", "event": "dashboard.updated"}
    await mgr.broadcast(msg, user_ids={actor_id, target_id}, actor_id=actor_id)

    assert actor_client.queue.qsize() == 1
    assert target_client.queue.qsize() == 1
    assert outsider_client.queue.qsize() == 0
    assert await target_client.queue.get() == msg


@pytest.mark.asyncio
async def test_evicted_client_receives_close_sentinel() -> None:
    """A client too far behind is told to resync, not silently dropped."""
    from app.sse.manager import _QUEUE_MAX, CLOSED_SENTINEL, SseManager

    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id)

    # Fill the queue to capacity so the next broadcast evicts.
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler", "data": "{}"})

    await mgr.broadcast({"event": "list.updated", "data": "{}"}, user_ids={user_id}, actor_id=user_id)

    # Evicted from the registry...
    assert client not in mgr._clients
    # ...and the backlog is replaced by a single close sentinel it will actually see.
    assert client.queue.qsize() == 1
    assert client.queue.get_nowait() is CLOSED_SENTINEL


@pytest.mark.asyncio
async def test_manager_multiple_connections_same_user() -> None:
    """Two open tabs for the same user both receive targeted events."""
    mgr = SseManager()
    user_id = uuid.uuid4()

    tab1 = mgr.connect(user_id)
    tab2 = mgr.connect(user_id)

    msg = {"data": "update", "event": "list.updated"}
    await mgr.broadcast(msg, user_ids={user_id}, actor_id=user_id)

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
    assert "group_id" not in payload


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


@pytest.mark.asyncio
async def test_stream_ends_with_resync_on_close_sentinel() -> None:
    """An evicted stream yields resync and terminates rather than hanging."""
    from app.routers.sse import stream_events
    from app.sse.manager import CLOSED_SENTINEL, SseManager

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())

    gen = stream_events(client, send_resync=False)
    first = await gen.__anext__()
    assert first["event"] == "connected"

    client.queue.put_nowait({"event": "list.updated", "data": "{}"})
    assert (await gen.__anext__())["event"] == "list.updated"

    client.queue.put_nowait(CLOSED_SENTINEL)
    assert (await gen.__anext__())["event"] == "resync"

    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()


@pytest.mark.asyncio
async def test_stream_sends_resync_first_on_reconnect() -> None:
    """send_resync=True (Last-Event-ID present) replays a resync up front."""
    from app.routers.sse import stream_events
    from app.sse.manager import SseManager

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())

    gen = stream_events(client, send_resync=True)
    assert (await gen.__anext__())["event"] == "connected"
    assert (await gen.__anext__())["event"] == "resync"
    await gen.aclose()


@pytest.mark.asyncio
async def test_stream_deregisters_client_from_its_own_manager() -> None:
    """Closing the stream removes the client from the manager that created it."""
    from app.routers.sse import stream_events
    from app.sse.manager import SseManager

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())
    assert client in mgr._clients

    gen = stream_events(client, send_resync=False)
    await gen.__anext__()  # 'connected'
    await gen.aclose()

    assert client not in mgr._clients
