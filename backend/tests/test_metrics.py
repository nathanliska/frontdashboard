"""Tests for the Prometheus scrape endpoint and its counters."""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from prometheus_client import generate_latest

from app import metrics
from app.main import app
from app.sse.manager import _QUEUE_MAX, SseManager


def _sample(name: str, **labels: str) -> float:
    """Read one series out of the registry, or 0 when it has not been touched yet."""
    for metric in metrics.HTTP_RESPONSES.collect() if labels else []:
        for sample in metric.samples:
            if sample.name == name and all(sample.labels.get(k) == v for k, v in labels.items()):
                return sample.value
    if labels:
        return 0.0
    for collector in (
        metrics.SSE_EVICTIONS,
        metrics.SSE_EXPIRIES,
        metrics.SSE_CONNECTS,
        metrics.RATE_LIMITED,
    ):
        for metric in collector.collect():
            for sample in metric.samples:
                if sample.name == name:
                    return sample.value
    return 0.0


def test_route_label_uses_the_template_not_the_raw_path() -> None:
    """A series per URL is how a path scanner turns metrics into a memory leak."""
    from app.middleware import _route_label

    class _Route:
        path = "/dashboards/{dashboard_id}"

    assert _route_label({"route": _Route(), "path": "/api/dashboards/abc"}) == "/api/dashboards/{dashboard_id}"
    assert _route_label({}) == "unmatched"
    assert _route_label({"route": object()}) == "unmatched"


def test_observe_response_buckets_by_status_class() -> None:
    """Class rather than code, so a 404 storm cannot mint a series per variant."""
    before = _sample("frontdashboard_http_responses_total", method="GET", route="/x", status_class="4xx")

    metrics.observe_response("GET", "/x", 404)
    metrics.observe_response("GET", "/x", 418)

    after = _sample("frontdashboard_http_responses_total", method="GET", route="/x", status_class="4xx")
    assert after - before == 2


@pytest.mark.asyncio
async def test_eviction_counter_follows_a_dropped_client() -> None:
    """The eviction count is how a slow-client problem becomes visible at all."""
    before = _sample("frontdashboard_sse_evictions_total")
    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id, session_id=uuid.uuid4())
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler"})

    await mgr.broadcast({"event": "overflow"}, actor_id=user_id)

    assert _sample("frontdashboard_sse_evictions_total") - before == 1
    assert mgr.client_count == 0


@pytest.mark.asyncio
async def test_stream_closes_on_the_lifetime_cap_without_a_resync() -> None:
    """A recycled stream must not cost a refetch — the client's mark decides on reconnect."""
    from datetime import timedelta

    from app.routers.sse import stream_events
    from app.sse.events import connected_dict

    before = _sample("frontdashboard_sse_expiries_total")
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
    assert _sample("frontdashboard_sse_expiries_total") - before == 1
    assert mgr.client_count == 0, "the finally block must unregister the client"


def test_client_count_tracks_connect_and_disconnect() -> None:
    """The gauge reads straight off the registry, so it has to follow both edges."""
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    assert mgr.client_count == 1

    mgr.disconnect(client)

    assert mgr.client_count == 0


def test_scrape_carries_help_and_type_for_every_series() -> None:
    """A series without HELP/TYPE parses but reads as unlabelled noise on a dashboard."""
    body = generate_latest().decode()

    for line in body.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        name = line.split("{")[0].split(" ")[0].removesuffix("_total").removesuffix("_created")
        assert f"# HELP {name}" in body or f"# HELP {name}_total" in body


@pytest.mark.asyncio
async def test_metrics_endpoint_is_outside_the_api_prefix() -> None:
    """Caddy proxies only /api/*, so this path is what keeps the numbers off the internet."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        served = await client.get("/metrics")
        under_api = await client.get("/api/metrics")

    assert served.status_code == 200
    assert "text/plain" in served.headers["content-type"]
    assert "frontdashboard_sse_clients" in served.text
    assert under_api.status_code == 404


@pytest.mark.asyncio
async def test_metrics_endpoint_reports_pool_gauges() -> None:
    """The pool numbers are the ones any future autoscaling decision would read."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        body = (await client.get("/metrics")).text

    assert "frontdashboard_db_pool_checked_out" in body
    assert "frontdashboard_db_pool_limit" in body
    # Never negative: SQLAlchemy counts overflow up from -pool_size, which reads as nonsense.
    overflow = next(line for line in body.splitlines() if line.startswith("frontdashboard_db_pool_overflow "))
    assert float(overflow.split()[1]) >= 0
