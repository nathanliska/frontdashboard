"""Tests for the Prometheus scrape endpoint and its counters."""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app import metrics
from app.main import app
from app.sse.manager import _QUEUE_MAX, SseManager


@pytest.fixture(autouse=True)
def _zero_counters():
    metrics.reset()
    yield
    metrics.reset()


def test_render_emits_help_and_type_for_every_series() -> None:
    """A series without HELP/TYPE parses but reads as unlabelled noise on a dashboard."""
    body = metrics.render({"sse_clients": 3})

    for line in body.splitlines():
        if line.startswith("#"):
            continue
        name = line.split(" ")[0]
        assert f"# HELP {name} " in body
        assert f"# TYPE {name} " in body


def test_render_rejects_a_gauge_with_no_help_text() -> None:
    """Better to fail the scrape than to publish a series nobody can interpret."""
    with pytest.raises(KeyError):
        metrics.render({"invented_gauge": 1})


def test_increment_ignores_an_unknown_counter() -> None:
    """Observing a request must never be able to fail it."""
    metrics.increment("not_a_counter")

    assert "not_a_counter" not in metrics.counters()


@pytest.mark.asyncio
async def test_eviction_counter_follows_a_dropped_client() -> None:
    """The eviction count is how a slow-client problem becomes visible at all."""
    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id, session_id=uuid.uuid4())
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler"})

    assert metrics.counters()[metrics.SSE_EVICTIONS] == 0

    await mgr.broadcast({"event": "overflow"}, actor_id=user_id)

    assert metrics.counters()[metrics.SSE_EVICTIONS] == 1
    assert mgr.client_count == 0


@pytest.mark.asyncio
async def test_client_count_tracks_connect_and_disconnect() -> None:
    """The gauge is read straight off the registry, so it has to follow both edges."""
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    assert mgr.client_count == 1

    mgr.disconnect(client)

    assert mgr.client_count == 0


def test_observe_status_buckets_only_failures() -> None:
    """2xx and 3xx are the normal case; counting them would bury the signal."""
    for code in (200, 204, 302, 404, 429, 500, 503):
        metrics.observe_status(code)

    counts = metrics.counters()
    assert counts[metrics.HTTP_4XX] == 2
    assert counts[metrics.HTTP_5XX] == 2


def test_set_gauge_ignores_an_unknown_name() -> None:
    """Same rule as counters: observation must never raise into the thing it observes."""
    metrics.set_gauge("not_a_gauge", 5)

    assert "not_a_gauge" not in metrics.render({})


@pytest.mark.asyncio
async def test_stream_closes_on_the_lifetime_cap_without_a_resync() -> None:
    """A recycled stream must not cost a refetch — the client's mark decides on reconnect."""
    from datetime import timedelta

    from app.routers.sse import stream_events
    from app.sse.events import connected_dict

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    async def always_live(_session_id: uuid.UUID) -> bool:
        return True

    frames = [
        frame
        async for frame in stream_events(
            client,
            send_resync=False,
            revalidate=always_live,
            max_lifetime=timedelta(0),
        )
    ]

    assert frames == [connected_dict(None)], "a lifetime close must send no resync frame"
    assert metrics.counters()[metrics.SSE_EXPIRIES] == 1
    assert mgr.client_count == 0, "the finally block must unregister the client"


@pytest.mark.asyncio
async def test_metrics_endpoint_is_outside_the_api_prefix() -> None:
    """Caddy proxies only /api/*, so this path is what keeps the numbers off the internet."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        served = await client.get("/metrics")
        under_api = await client.get("/api/metrics")

    assert served.status_code == 200
    assert served.headers["content-type"].startswith("text/plain; version=0.0.4")
    assert "frontdashboard_sse_clients" in served.text
    assert under_api.status_code == 404


@pytest.mark.asyncio
async def test_metrics_endpoint_reports_pool_gauges() -> None:
    """The pool numbers are the ones any future autoscaling decision would read."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        body = (await client.get("/metrics")).text

    assert "frontdashboard_db_pool_checked_out" in body
    assert "frontdashboard_db_pool_size" in body
