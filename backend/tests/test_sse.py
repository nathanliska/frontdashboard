"""Tests for SSE infrastructure (Step 11).

Unit tests cover the SseManager directly (no DB needed).
Integration tests cover the /api/sse endpoint: auth guard, correct headers,
reconnect resync behavior.
"""

import json
import uuid

import anyio
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import EventType
from app.services.activity import current_event_id
from app.sse.events import connected_dict
from app.sse.manager import _QUEUE_MAX, OVERFLOW_SENTINEL, REVOKED_SENTINEL, SseManager
from tests.helpers import register_user, set_csrf

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _always_live(_session_id: uuid.UUID) -> bool:
    return True


async def _never_live(_session_id: uuid.UUID) -> bool:
    return False


# ---------------------------------------------------------------------------
# SseManager unit tests (no DB, no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manager_connect_disconnect() -> None:
    mgr = SseManager()
    u = uuid.uuid4()

    client = mgr.connect(u, session_id=uuid.uuid4())
    assert len(mgr._clients) == 1

    mgr.disconnect(client)
    assert len(mgr._clients) == 0


@pytest.mark.asyncio
async def test_manager_disconnect_idempotent() -> None:
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    mgr.disconnect(client)
    mgr.disconnect(client)  # should not raise


@pytest.mark.asyncio
async def test_manager_broadcast_private_only_to_actor() -> None:
    mgr = SseManager()
    actor_id = uuid.uuid4()
    other_id = uuid.uuid4()

    actor_client = mgr.connect(actor_id, session_id=uuid.uuid4())
    other_client = mgr.connect(other_id, session_id=uuid.uuid4())

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

    actor_client = mgr.connect(actor_id, session_id=uuid.uuid4())
    target_client = mgr.connect(target_id, session_id=uuid.uuid4())
    outsider_client = mgr.connect(outsider_id, session_id=uuid.uuid4())

    msg = {"data": "dashboard update", "event": "dashboard.updated"}
    await mgr.broadcast(msg, user_ids={actor_id, target_id}, actor_id=actor_id)

    assert actor_client.queue.qsize() == 1
    assert target_client.queue.qsize() == 1
    assert outsider_client.queue.qsize() == 0
    assert await target_client.queue.get() == msg


@pytest.mark.asyncio
async def test_overflowing_client_keeps_its_stream_and_gets_one_resync() -> None:
    """A client too far behind is told to resync in place, not disconnected."""
    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id, session_id=uuid.uuid4())

    # Fill the queue to capacity so the next broadcast overflows.
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler", "data": "{}"})

    await mgr.broadcast({"event": "list.updated", "data": "{}"}, user_ids={user_id}, actor_id=user_id)

    # Still registered — the stream survives the overflow...
    assert client in mgr._clients
    # ...and the backlog is replaced by a single overflow sentinel it will actually see.
    assert client.queue.qsize() == 1
    assert client.resync_pending
    assert client.queue.get_nowait() is OVERFLOW_SENTINEL


@pytest.mark.asyncio
async def test_frames_are_dropped_while_a_resync_is_pending() -> None:
    """Between overflow and the resync's delivery, frames add nothing the refetch won't cover."""
    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id, session_id=uuid.uuid4())
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler", "data": "{}"})
    await mgr.broadcast({"event": "list.updated", "data": "{}"}, user_ids={user_id}, actor_id=user_id)

    await mgr.broadcast({"event": "list.updated", "data": "{}"}, user_ids={user_id}, actor_id=user_id)
    await mgr.broadcast({"event": "list.deleted", "data": "{}"}, user_ids={user_id}, actor_id=user_id)

    # Both asserts, or this passes against eviction too: an evicted client also keeps qsize 1,
    # by being absent from the registry rather than by dropping.
    assert client in mgr._clients and client.resync_pending
    assert client.queue.qsize() == 1, "the pending resync stays the only thing queued"


@pytest.mark.asyncio
async def test_manager_multiple_connections_same_user() -> None:
    """Two open tabs for the same user both receive targeted events."""
    mgr = SseManager()
    user_id = uuid.uuid4()

    tab1 = mgr.connect(user_id, session_id=uuid.uuid4())
    tab2 = mgr.connect(user_id, session_id=uuid.uuid4())

    msg = {"data": "update", "event": "list.updated"}
    await mgr.broadcast(msg, user_ids={user_id}, actor_id=user_id)

    assert tab1.queue.qsize() == 1
    assert tab2.queue.qsize() == 1


def test_client_count_is_streams_not_people() -> None:
    """One person on a laptop with two tabs plus a phone is three streams, and the gauge says so.

    The count is deliberately per-stream: it sums across replicas because the sets are disjoint,
    which a distinct count of users or devices would not.
    """
    mgr = SseManager()
    reader = uuid.uuid4()
    laptop = uuid.uuid4()

    mgr.connect(reader, session_id=laptop)
    mgr.connect(reader, session_id=laptop)  # second tab, same device
    mgr.connect(reader, session_id=uuid.uuid4())  # phone
    assert mgr.client_count == 3

    housemate = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    assert mgr.client_count == 4

    mgr.disconnect(housemate)
    assert mgr.client_count == 3


# ---------------------------------------------------------------------------
# sse.py unit tests
# ---------------------------------------------------------------------------


def test_initial_connect_without_a_mark_skips_resync() -> None:
    """A first connect follows the components' own fetches; resyncing would double every one."""
    from app.routers.sse import _resync_needed

    assert _resync_needed(None, 123) is False


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

    await register_user(db_client, "alice@example.com", display_name="Alice")

    set_csrf(db_client)
    dash_resp = await db_client.post("/api/dashboards", json={"name": "SSE Test"})
    assert dash_resp.status_code == 201
    dashboard_id = dash_resp.json()["id"]

    set_csrf(db_client)
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


def test_resync_dict_carries_the_head_only_when_given_one() -> None:
    """The head moves the client's mark, so it must appear exactly when the caller read one."""
    from app.sse.events import resync_dict

    stamped = resync_dict(last_event_id=42)
    assert json.loads(stamped["data"])["last_event_id"] == 42
    assert stamped["id"] == "42"

    plain = resync_dict()
    assert "last_event_id" not in json.loads(plain["data"])
    assert "id" not in plain


def test_connected_dict_primes_the_log_head() -> None:
    """The connect frame must hand over a usable mark, not a sentinel."""
    from app.sse.events import connected_dict

    msg = connected_dict(41)
    assert msg["event"] == "connected"
    # A non-numeric id here is what used to force a resync on every reconnect of an idle tab:
    # the client had nothing to offer the server but a string.
    assert msg["id"] == "41"
    assert json.loads(msg["data"]) == {"last_event_id": 41}


def test_connected_dict_omits_the_id_on_an_empty_log() -> None:
    """Nothing has been logged, so there is no mark to claim."""
    from app.sse.events import connected_dict

    msg = connected_dict(None)
    assert "id" not in msg
    assert json.loads(msg["data"]) == {"last_event_id": None}


@pytest.mark.parametrize(
    ("watermark", "head", "expected"),
    [
        (None, 7, False),
        (None, None, False),
        (7, 7, False),
        (7, 9, True),
        (9, 7, False),
        (7, None, False),
    ],
)
def test_resync_needed(watermark: int | None, head: int | None, expected: bool) -> None:
    """A mark the log has not moved past is proof the client missed nothing."""
    from app.routers.sse import _resync_needed

    assert _resync_needed(watermark, head) is expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("41", 41), ("connected", None), (None, None), ("", None), ("nope", None)],
)
def test_parse_watermark(raw: str | None, expected: int | None) -> None:
    """Anything unparseable has to read as absent, which resyncs rather than skipping events."""
    from app.routers.sse import _parse_watermark

    assert _parse_watermark(raw) == expected


def test_resync_dict_omits_scopes_when_they_are_unknown() -> None:
    """Absent scopes must read as "refetch everything", never as "nothing changed"."""
    from app.sse.events import resync_dict

    assert "scopes" not in json.loads(resync_dict()["data"])
    assert json.loads(resync_dict(set())["data"])["scopes"] == []


@pytest.mark.asyncio
async def test_changed_scopes_exclude_dashboards_the_user_cannot_see(db_session: AsyncSession) -> None:
    """Naming what changed must not report activity on someone else's dashboard."""
    from app.services.activity import entity_types_changed_since, log_event

    mine, theirs = uuid.uuid4(), uuid.uuid4()
    before = await current_event_id(db_session) or 0

    for entity_type, dashboard_id in (("list", mine), ("calendar_event", theirs)):
        log_event(
            db_session,
            event_type=EventType.list_created,
            actor_id=uuid.uuid4(),
            actor_display_name="Tester",
            entity_type=entity_type,
            entity_id=uuid.uuid4(),
            payload={"dashboard_id": str(dashboard_id)},
        )
    await db_session.flush()

    assert await entity_types_changed_since(db_session, before, {mine}) == {"list"}
    assert await entity_types_changed_since(db_session, before, {theirs}) == {"calendar_event"}
    assert await entity_types_changed_since(db_session, before, set()) == set()


@pytest.mark.asyncio
async def test_changed_scopes_give_up_past_the_cap(db_session: AsyncSession) -> None:
    """Past the bound the honest answer is None — unknown — which resyncs everything."""
    from app.services.activity import entity_types_changed_since, log_event

    dashboard_id = uuid.uuid4()
    before = await current_event_id(db_session) or 0
    for _ in range(4):
        log_event(
            db_session,
            event_type=EventType.list_created,
            actor_id=uuid.uuid4(),
            actor_display_name="Tester",
            entity_type="list",
            entity_id=uuid.uuid4(),
            payload={"dashboard_id": str(dashboard_id)},
        )
    await db_session.flush()

    assert await entity_types_changed_since(db_session, before, {dashboard_id}, limit=3) is None
    assert await entity_types_changed_since(db_session, before, {dashboard_id}, limit=10) == {"list"}


@pytest.mark.asyncio
async def test_current_event_id_tracks_the_newest_committed_row(db_session: AsyncSession) -> None:
    """The head must follow the log, since it is what every reconnect is judged against."""
    from app.services.activity import current_event_id, log_event

    before = await current_event_id(db_session)

    log_event(
        db_session,
        event_type=EventType.list_created,
        actor_id=uuid.uuid4(),
        actor_display_name="Tester",
        entity_type="list",
        entity_id=uuid.uuid4(),
        payload={"dashboard_id": str(uuid.uuid4())},
    )
    await db_session.flush()

    after = await current_event_id(db_session)
    assert after is not None
    assert before is None or after > before


@pytest.mark.asyncio
async def test_stream_resyncs_in_place_on_overflow_and_keeps_going() -> None:
    """The overflow sentinel becomes one resync frame, clears the pending flag, and the stream lives.

    The continuation is the point: ending here would send the still-slow client back into the
    burst that overflowed it, to reconnect and refetch once per overflow instead of once.
    """
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    async def head_42() -> int:
        return 42

    gen = stream_events(client, send_resync=False, revalidate=_always_live, read_head=head_42)
    first = await gen.__anext__()
    assert first["event"] == "connected"

    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler", "data": "{}"})
    await mgr.broadcast({"event": "list.updated", "data": "{}"}, actor_id=client.user_id)

    frame = await gen.__anext__()
    assert frame["event"] == "resync"
    # Stamped with the head, so the client's mark moves with the refetch instead of going stale.
    assert json.loads(frame["data"])["last_event_id"] == 42
    assert not client.resync_pending, "delivering the resync reopens the queue"

    await mgr.broadcast({"event": "list.updated", "data": "{}"}, actor_id=client.user_id)
    assert (await gen.__anext__())["event"] == "list.updated"
    await gen.aclose()


@pytest.mark.asyncio
async def test_overflow_resync_survives_a_failing_head_read() -> None:
    """The stamp is best-effort: a dead database costs the mark refresh, never the stream."""
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    async def head_raises() -> int:
        raise RuntimeError("database unreachable")

    gen = stream_events(client, send_resync=False, revalidate=_always_live, read_head=head_raises)
    assert (await gen.__anext__())["event"] == "connected"

    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler", "data": "{}"})
    await mgr.broadcast({"event": "list.updated", "data": "{}"}, actor_id=client.user_id)

    frame = await gen.__anext__()
    assert frame["event"] == "resync"
    assert "last_event_id" not in json.loads(frame["data"])

    await mgr.broadcast({"event": "list.updated", "data": "{}"}, actor_id=client.user_id)
    assert (await gen.__anext__())["event"] == "list.updated"
    await gen.aclose()


@pytest.mark.asyncio
async def test_stream_sends_resync_first_on_reconnect() -> None:
    """send_resync=True puts the resync ahead of any live frame, so nothing is applied over it."""
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    gen = stream_events(client, send_resync=True, revalidate=_always_live)
    assert (await gen.__anext__())["event"] == "connected"
    assert (await gen.__anext__())["event"] == "resync"
    await gen.aclose()


@pytest.mark.asyncio
async def test_stream_deregisters_client_from_its_own_manager() -> None:
    """Closing the stream removes the client from the manager that created it."""
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    assert client in mgr._clients

    gen = stream_events(client, send_resync=False, revalidate=_always_live)
    await gen.__anext__()  # 'connected'
    await gen.aclose()

    assert client not in mgr._clients


# ---------------------------------------------------------------------------
# Session revocation tests (Task 7)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_ends_when_revalidation_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guarantee: a revoked session stops streaming, with no help from the manager.

    `_REVALIDATE_EVERY` is shrunk to 0 so the deadline is already due at loop entry and `_never_live`
    is actually exercised, rather than the stream idling out through `move_on_after` first.

    The pre-queued sentinel is what makes the assertion mean something. A stream that calls
    `revalidate` but ignores its `False` result would still pass a call-count check — it blocks on
    an empty queue and gets cut off by `move_on_after` with the right frames for the wrong reason.
    Correct code returns before reaching `wait_for`, so the sentinel is never drained; the broken
    version drains it and fails on the extra frame.
    """
    from datetime import timedelta

    from app.routers import sse as sse_router
    from app.routers.sse import stream_events

    monkeypatch.setattr(sse_router, "_REVALIDATE_EVERY", timedelta(seconds=0))

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    client.queue.put_nowait({"event": "x", "data": "{}"})

    calls = 0

    async def revalidate(session_id: uuid.UUID) -> bool:
        nonlocal calls
        calls += 1
        return await _never_live(session_id)

    frames = []
    gen = stream_events(client, send_resync=False, revalidate=revalidate)
    with anyio.move_on_after(2):
        async for frame in gen:
            frames.append(frame)

    assert calls >= 1, "revalidate was never called — the deadline never fired"
    assert frames == [connected_dict()], "no resync frame — the client must re-auth, not refetch"


@pytest.mark.asyncio
async def test_revalidation_deadline_fires_on_a_busy_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    """A busy stream must still revalidate its session.

    The idle-timeout trap: a check hung off the TimeoutError branch would never run here.
    _REVALIDATE_EVERY is 30s in production — far longer than any test should run.
    It's shrunk to 0 here so the deadline is always already due, deterministically
    (not dependent on how fast this machine drains 50 already-queued items, which
    can be faster than any wall-clock interval we'd otherwise pick).
    """
    from datetime import timedelta

    from app.routers import sse as sse_router
    from app.routers.sse import stream_events

    monkeypatch.setattr(sse_router, "_REVALIDATE_EVERY", timedelta(seconds=0))

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    for _ in range(50):
        client.queue.put_nowait({"event": "noise", "data": "{}"})

    calls = 0

    async def revalidate(_session_id: uuid.UUID) -> bool:
        nonlocal calls
        calls += 1
        return calls < 2  # live once, then revoked

    frames = []
    with anyio.move_on_after(2):
        async for frame in stream_events(client, send_resync=False, revalidate=revalidate):
            frames.append(frame)

    assert calls >= 2, "the deadline never fired while the queue was busy"
    assert len(frames) < 51, "the stream must end, not drain the whole queue"


@pytest.mark.asyncio
async def test_revoked_sentinel_ends_the_stream_without_a_resync() -> None:
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    client.queue.put_nowait(REVOKED_SENTINEL)

    frames = []
    with anyio.move_on_after(2):
        async for frame in stream_events(client, send_resync=False, revalidate=_always_live):
            frames.append(frame)

    assert frames == [connected_dict()]


@pytest.mark.asyncio
async def test_disconnect_session_only_drops_that_session() -> None:
    mgr = SseManager()
    session_a, session_b = uuid.uuid4(), uuid.uuid4()
    user = uuid.uuid4()
    a = mgr.connect(user, session_id=session_a)
    b = mgr.connect(user, session_id=session_b)

    mgr.disconnect_session(session_a)

    assert a.queue.get_nowait() is REVOKED_SENTINEL
    assert b.queue.empty(), "the user's other devices are untouched"


@pytest.mark.asyncio
async def test_overflow_still_resyncs() -> None:
    """No regression to 44a9e15: falling behind is not the same as being revoked."""
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    for _ in range(_QUEUE_MAX + 5):
        await mgr.broadcast({"event": "x", "data": "{}"}, actor_id=client.user_id)

    assert client.queue.get_nowait() is OVERFLOW_SENTINEL


@pytest.mark.asyncio
async def test_revocation_reaches_a_client_with_a_full_queue() -> None:
    """The backlog yields to the sentinel — a revoked stream must not keep serving its buffer."""
    mgr = SseManager()
    session_id = uuid.uuid4()
    client = mgr.connect(uuid.uuid4(), session_id=session_id)
    while not client.queue.full():
        client.queue.put_nowait({"event": "filler", "data": "{}"})

    mgr.disconnect_session(session_id)

    assert client.queue.qsize() == 1
    assert client.queue.get_nowait() is REVOKED_SENTINEL
