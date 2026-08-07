"""Cross-worker SSE fan-out.

Every assertion here is on something a single-process run cannot show: that a worker skips the
frames it published itself, and that an outage produces exactly one resync rather than one per
retry — which would refetch every open tab, every second, for as long as Redis stayed down.
"""

import asyncio
import uuid

import pytest

from app.sse import broker, choreography

pytestmark = pytest.mark.unit


def test_a_frame_survives_the_round_trip() -> None:
    message = {"id": "7", "event": "list.item.created", "data": '{"x":1}'}
    audience = {uuid.uuid4(), uuid.uuid4()}
    actor = uuid.uuid4()

    decoded, user_ids, actor_id, origin = broker.decode(broker.encode(message, audience, actor))

    assert decoded == message
    assert user_ids == audience
    assert actor_id == actor
    assert origin == broker.WORKER_ID


def test_a_private_frame_keeps_its_empty_audience() -> None:
    """`None` and an empty set mean different things to `broadcast` — actor-only versus nobody."""
    _, user_ids, _, _ = broker.decode(broker.encode({}, None, uuid.uuid4()))

    assert user_ids is None


async def test_a_worker_ignores_the_frames_it_published(monkeypatch: pytest.MonkeyPatch) -> None:
    """Its own clients were served locally before the publish; delivering again would duplicate."""
    delivered: list[dict] = []
    monkeypatch.setattr(
        broker.manager,
        "broadcast",
        lambda message, **_: delivered.append(message) or asyncio.sleep(0),
    )

    await broker._deliver(broker.encode({"id": "1"}, None, uuid.uuid4()))

    assert delivered == []


async def test_a_siblings_frame_is_delivered(monkeypatch: pytest.MonkeyPatch) -> None:
    delivered: list[dict] = []
    monkeypatch.setattr(
        broker.manager,
        "broadcast",
        lambda message, **_: delivered.append(message) or asyncio.sleep(0),
    )
    raw = broker.encode({"id": "9"}, None, uuid.uuid4())
    foreign = raw.replace(broker.WORKER_ID, str(uuid.uuid4()))

    await broker._deliver(foreign)

    assert delivered == [{"id": "9"}]


async def test_a_hanging_publish_cannot_hold_a_committed_write(monkeypatch: pytest.MonkeyPatch) -> None:
    """A committed write must never wait on the fan-out, whatever the failure mode underneath.

    Against a stopped Redis container, resolving its hostname was measured at anywhere from 0.25s
    to 3.9s — so the ceiling is asserted here rather than left to redis-py's socket timeouts.
    """
    attempts = 0

    class _Hangs:
        async def xadd(self, *_args: object, **_kwargs: object) -> object:
            nonlocal attempts
            attempts += 1
            await asyncio.sleep(3600)

    monkeypatch.setattr(broker, "_publisher_client", _Hangs)
    monkeypatch.setattr(broker, "_PUBLISH_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(broker, "_publish_retry_after", 0.0)
    frame = ({"id": "1"}, uuid.uuid4())

    for _ in range(2):
        await asyncio.wait_for(broker.publish(frame[0], user_ids=None, actor_id=frame[1]), timeout=5)

    assert attempts == 1, "the second write found the breaker unarmed and paid the stall again"


async def _run_reader(monkeypatch: pytest.MonkeyPatch, script: list[object]) -> list[dict]:
    """Drive `run_subscriber` through a scripted sequence of reads, returning the resyncs it sent."""
    resyncs: list[dict] = []
    remaining = list(script)
    stop = asyncio.Event()

    class _FakeRedis:
        async def xread(self, *_args: object, **_kwargs: object) -> object:
            if not remaining:
                stop.set()
                return []
            item = remaining.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(broker, "_reader_client", _FakeRedis)
    monkeypatch.setattr(broker, "_RECONNECT_DELAY_SECONDS", 0)
    monkeypatch.setattr(broker.manager, "deliver_to_all", resyncs.append)

    await asyncio.wait_for(broker.run_subscriber(stop=stop), timeout=5)
    return resyncs


async def test_a_healthy_reader_never_resyncs(monkeypatch: pytest.MonkeyPatch) -> None:
    resyncs = await _run_reader(monkeypatch, [[]])

    assert resyncs == []


async def test_an_outage_resyncs_once_however_long_it_lasts(monkeypatch: pytest.MonkeyPatch) -> None:
    """The bug this replaces resynced on every failed retry, once a second, to every open tab."""
    outage = [ConnectionError("redis is down") for _ in range(25)]

    resyncs = await _run_reader(monkeypatch, [*outage, []])

    assert len(resyncs) == 1, f"one resync per outage, got {len(resyncs)}"
    assert resyncs[0]["event"] == "resync"


async def test_two_outages_resync_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    """The flag has to reset on recovery, or only the first outage would ever be repaired."""
    script: list[object] = [ConnectionError("down"), [], ConnectionError("down again"), []]

    resyncs = await _run_reader(monkeypatch, script)

    assert len(resyncs) == 2


async def test_an_unusable_redis_url_does_not_end_the_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    """`from_url` raises on a malformed scheme, and this task never restarts.

    Escaping here would leave the worker serving traffic and reading nothing, for its whole life,
    with no error anywhere — a missing colon in `.env.prod` is the realistic cause.
    """
    attempts = 0
    stop = asyncio.Event()

    def _explode() -> object:
        nonlocal attempts
        attempts += 1
        if attempts >= 3:
            stop.set()
        raise ValueError("Redis URL must specify one of the following schemes")

    monkeypatch.setattr(broker, "_reader_client", _explode)
    monkeypatch.setattr(broker, "_RECONNECT_DELAY_SECONDS", 0)
    monkeypatch.setattr(broker.manager, "deliver_to_all", lambda _message: None)

    await asyncio.wait_for(broker.run_subscriber(stop=stop), timeout=5)

    assert attempts >= 3, "the reader gave up instead of retrying"


def test_a_backed_up_client_is_evicted_rather_than_skipped() -> None:
    """The resync repairs the client most likely to be behind, so a full queue must not skip it.

    Suppressing the overflow would leave it connected and quietly stale — the one state the
    recovery resync exists to prevent.
    """
    from app.sse.manager import CLOSED_SENTINEL, SseManager

    manager = SseManager()
    client = manager.connect(uuid.uuid4(), session_id=uuid.uuid4())
    while not client.queue.full():
        client.queue.put_nowait({"filler": True})

    manager.deliver_to_all({"event": "resync"})

    assert manager.client_count == 0, "a client that cannot take the resync must be dropped"
    assert client.queue.get_nowait() is CLOSED_SENTINEL


def test_the_reader_cannot_block_forever_on_a_wedged_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    """Asserted on the bound rather than the clock: a refused port fails fast and proves nothing.

    A blackholed host sends no RST, so an unbounded read never returns and never raises — the
    reader would sit there while its clients quietly missed every sibling frame.
    """
    assert broker._READ_TIMEOUT_SECONDS > broker._BLOCK_MS / 1000, (
        "the read timeout must exceed the server-side block, or an idle read trips it every time"
    )
    # The suite runs on `memory://`, which `from_url` rejects; the value here is never connected to.
    monkeypatch.setattr(broker.settings, "redis_url", "redis://127.0.0.1:6399/0")

    configured = broker._reader_client().connection_pool.connection_kwargs["socket_timeout"]

    assert configured == broker._READ_TIMEOUT_SECONDS, "the reader must carry the bound, not just define it"


async def test_a_committed_write_reaches_the_other_workers(monkeypatch: pytest.MonkeyPatch) -> None:
    """The seam's publish is what makes fan-out happen at all, and nothing else asserts it.

    Order is the other half: local clients are served before the publish, so a Redis fault costs
    siblings the frame rather than costing this worker's own clients theirs.
    """
    calls: list[str] = []
    message = {"id": "1", "event": "list.updated"}
    audience = {uuid.uuid4()}
    actor = uuid.uuid4()

    class _Session:
        async def commit(self) -> None:
            calls.append("commit")

    async def _broadcast(msg: dict, **_kwargs: object) -> None:
        calls.append("local")
        assert msg == message

    async def _publish(msg: dict, *, user_ids: set[uuid.UUID] | None, actor_id: uuid.UUID) -> None:
        calls.append("publish")
        assert (msg, user_ids, actor_id) == (message, audience, actor)

    monkeypatch.setattr(choreography.manager, "broadcast", _broadcast)
    monkeypatch.setattr(choreography.broker, "publish", _publish)

    await choreography.commit_and_broadcast(
        _Session(),  # ty: ignore[invalid-argument-type]
        actor_id=actor,
        fanouts=[choreography.Fanout(message, audience)],
    )

    assert calls == ["commit", "local", "publish"], f"expected commit, then local, then publish; got {calls}"


def test_the_app_still_starts_when_redis_is_unusable() -> None:
    """The wiring, not the function: `run_subscriber` is only started by the lifespan.

    Both fan-out bugs found so far were invisible to the suite because nothing ran it that way.
    Tests set REDIS_URL to `memory://`, which `from_url` rejects — so this is also the broken
    `.env.prod` case, and the app must come up and stay up regardless.
    """
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app):
        task = app.state.fanout_task
        assert not task.done(), "the fan-out reader died on startup"
