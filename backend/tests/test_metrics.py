"""Tests for the Prometheus scrape endpoint and its counters."""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from prometheus_client import Histogram, generate_latest

from app import metrics
from app.main import app
from app.metrics import _PREFIX
from app.routers.sse import stream_events
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
        metrics.SSE_OVERFLOW_RESYNCS,
        metrics.SSE_EXPIRIES,
        metrics.SSE_CONNECTS,
        metrics.SSE_EVENTS_SENT,
        metrics.RATE_LIMITED,
    ):
        for metric in collector.collect():
            for sample in metric.samples:
                if sample.name == name:
                    return sample.value
    return 0.0


def _route_total(route: str) -> float:
    """Every response counted for one route, whatever the status class."""
    total = 0.0
    for metric in metrics.HTTP_RESPONSES.collect():
        for sample in metric.samples:
            if sample.name == "frontdashboard_http_responses_total" and sample.labels.get("route") == route:
                total += sample.value
    return total


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
async def test_overflow_counter_counts_bursts_not_dropped_frames() -> None:
    """The overflow count is how a slow-client problem becomes visible at all.

    One per coalesced burst: frames dropped while the resync is pending are the coalescing
    working, and counting them would read as a storm.
    """
    before = _sample("frontdashboard_sse_overflow_resyncs_total")
    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id, session_id=uuid.uuid4())
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler"})

    await mgr.broadcast({"event": "overflow"}, actor_id=user_id)
    await mgr.broadcast({"event": "dropped while pending"}, actor_id=user_id)

    assert _sample("frontdashboard_sse_overflow_resyncs_total") - before == 1
    assert mgr.client_count == 1, "an overflowed client keeps its stream"


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


# A histogram publishes _bucket/_sum/_count alongside the name it declares HELP under, so the
# suffix list has to cover every type in the registry or this passes by not recognising one.
_SERIES_SUFFIXES = ("_total", "_created", "_bucket", "_sum", "_count")


def test_scrape_carries_help_and_type_for_every_series() -> None:
    """A series without HELP/TYPE parses but reads as unlabelled noise on a dashboard."""
    body = generate_latest().decode()

    for line in body.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        name = line.split("{")[0].split(" ")[0]
        for suffix in _SERIES_SUFFIXES:
            name = name.removesuffix(suffix)
        assert f"# HELP {name}" in body or f"# HELP {name}_total" in body


def _hist_count(histogram: Histogram, **labels: str) -> float:
    """The `_count` sample of a histogram, for one label set."""
    for metric in histogram.collect():
        for sample in metric.samples:
            if sample.name.endswith("_count") and all(sample.labels.get(k) == v for k, v in labels.items()):
                return sample.value
    return 0.0


@pytest.mark.asyncio
async def test_request_duration_is_timed_to_the_response_start() -> None:
    """Timed at the headers, not the last byte — otherwise one SSE stream skews every quantile."""
    before = _hist_count(metrics.HTTP_REQUEST_SECONDS, route="/api/health/ready")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.get("/api/health/ready")

    assert _hist_count(metrics.HTTP_REQUEST_SECONDS, route="/api/health/ready") - before == 1


def test_request_duration_is_not_labelled_by_method() -> None:
    """Every label multiplies by the bucket count; route is what a slow-endpoint hunt needs."""
    assert set(metrics.HTTP_REQUEST_SECONDS._labelnames) == {"route"}


@pytest.mark.asyncio
async def test_delivered_frames_are_counted_but_recovery_frames_are_not() -> None:
    """Only domain frames count as fan-out — a resync is recovery, and counting it would inflate it."""
    from app.sse.manager import OVERFLOW_SENTINEL

    before = _sample("frontdashboard_sse_events_sent_total")
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    client.queue.put_nowait({"event": "real"})
    client.resync_pending = True
    client.queue.put_nowait(OVERFLOW_SENTINEL)

    async def always_live(_session_id: uuid.UUID) -> bool:
        return True

    gen = stream_events(client, send_resync=False, revalidate=always_live)
    assert (await gen.__anext__())["event"] == "connected"
    assert (await gen.__anext__())["event"] == "real"
    assert (await gen.__anext__())["event"] == "resync"
    await gen.aclose()

    assert _sample("frontdashboard_sse_events_sent_total") - before == 1


@pytest.mark.asyncio
async def test_stream_lifetime_is_observed_however_the_stream_ends() -> None:
    """Connect counts cannot tell twenty healthy streams from twenty flapping ones; this can."""
    from datetime import timedelta

    before = _hist_count(metrics.SSE_STREAM_SECONDS)
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    async def always_live(_session_id: uuid.UUID) -> bool:
        return True

    # The lifetime cap path, which returns rather than falling out of the loop.
    [f async for f in stream_events(client, send_resync=False, revalidate=always_live, max_lifetime=timedelta(0))]

    assert _hist_count(metrics.SSE_STREAM_SECONDS) - before == 1, "the finally block must observe on every exit"


def test_no_created_series_are_published() -> None:
    """`_created` gauges are a third of the series and answer nothing — assert they stay gone."""
    body = generate_latest().decode()

    ours = [line.split("{")[0].split(" ")[0] for line in body.splitlines() if line.startswith(_PREFIX)]

    assert ours, "no frontdashboard series in the scrape — this assertion would pass vacuously"
    assert not [n for n in ours if n.endswith("_created")], "disable_created_metrics() is not taking effect"


@pytest.mark.asyncio
async def test_the_scrape_does_not_count_itself() -> None:
    """Prometheus reports scrape health as `up`; counting it here only outgrows real traffic."""
    before = _sample("frontdashboard_http_responses_total", method="GET", route="/metrics", status_class="2xx")

    health_before = _route_total("/api/health/ready")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/metrics")).status_code == 200
        # Whatever it answers without a database, it must still be counted.
        await client.get("/api/health/ready")

    after = _sample("frontdashboard_http_responses_total", method="GET", route="/metrics", status_class="2xx")
    assert after == before, "/metrics counted itself"

    # The public health endpoint stays counted: Caddy proxies it, so its volume is a real signal.
    assert _route_total("/api/health/ready") - health_before == 1


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

    assert "frontdashboard_db_pool_checked_out_peak" in body
    assert "frontdashboard_db_pool_limit" in body
    # Never negative: SQLAlchemy counts overflow up from -pool_size, which reads as nonsense.
    overflow = next(line for line in body.splitlines() if line.startswith("frontdashboard_db_pool_overflow "))
    assert float(overflow.split()[1]) >= 0


@pytest.mark.asyncio
async def test_metrics_endpoint_reports_argon2_saturation() -> None:
    """Saturation has to be a ratio, so the ceiling is published alongside the occupancy."""
    from app.config import settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        body = (await client.get("/metrics")).text

    limit = next(line for line in body.splitlines() if line.startswith("frontdashboard_argon2_limit "))
    assert float(limit.split()[1]) == settings.argon2_max_concurrency
    for gauge in ("frontdashboard_argon2_in_flight", "frontdashboard_argon2_waiting"):
        assert next(line for line in body.splitlines() if line.startswith(f"{gauge} "))


@pytest.mark.asyncio
async def test_argon2_latency_is_observed_per_operation() -> None:
    """The histogram is what survives sampling — a scrape lands between saturation bursts."""
    from app.auth.hashing import _DUMMY_HASH, verify_password

    def _count() -> float:
        for metric in metrics.ARGON2_SECONDS.collect():
            for sample in metric.samples:
                if sample.name == "frontdashboard_argon2_seconds_count" and sample.labels.get("operation") == "verify":
                    return sample.value
        return 0.0

    before = _count()

    assert await verify_password("not-the-equalizer-password", _DUMMY_HASH) is False

    assert _count() - before == 1, "a verify must be timed whether or not the password matched"
