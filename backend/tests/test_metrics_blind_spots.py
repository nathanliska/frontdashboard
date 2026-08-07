"""Failures that no other signal would show.

`test_metrics.py` proves the endpoint serves its metrics. What it cannot prove is that they see
anything. A connection is held for milliseconds against a 15s scrape, so an instantaneous gauge
reads zero through every burst worth catching; and an email send happens in a background task
after the response has gone, so no route ever 5xxs for one that failed.
"""

import contextlib
from collections.abc import AsyncIterator
from typing import get_args

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY
from sqlalchemy import event

from app import metrics
from app.metrics import WindowedPeak
from app.middleware import ResponseStatusMiddleware


class _Clock:
    """A hand-wound monotonic clock, so window expiry is exercised without sleeping."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_a_burst_between_reads_survives_to_the_next_one() -> None:
    gauge = WindowedPeak()

    gauge.record(4)
    gauge.record(7)
    gauge.record(2)

    # Everything is finished and released by the time the scrape lands.
    assert gauge.read(current=0) == 7


def test_scraping_twice_reports_the_same_peak() -> None:
    """The whole reason this is a window and not a reset: a scrape must not consume what it reports.

    Two Prometheus servers, or one plus a `curl` while debugging, would otherwise each be handed a
    different fraction of the same burst, with nothing to say which was the real one.
    """
    gauge = WindowedPeak()
    gauge.record(7)

    assert gauge.read(current=0) == 7
    assert gauge.read(current=0) == 7


def test_a_peak_falls_out_once_its_window_has_passed() -> None:
    """A spike belongs to its own window, or one burst reads as permanent saturation."""
    clock = _Clock()
    gauge = WindowedPeak(window_seconds=60, clock=clock)
    gauge.record(9)
    assert gauge.read(current=0) == 9

    clock.now += 61
    assert gauge.read(current=0) == 0


def test_a_resource_still_held_never_reads_as_free() -> None:
    """A pool in use must never read as idle, however the window happens to have emptied."""
    gauge = WindowedPeak()

    assert gauge.read(current=3) == 3


def test_a_level_held_into_a_window_is_not_forgotten_when_it_drops() -> None:
    """The distinguishing case for recording `current` rather than only comparing against it.

    Three connections held when a scrape lands are still held as the next window opens, so that
    window's peak is three even if they are all released and nothing new is ever recorded.
    """
    clock = _Clock()
    gauge = WindowedPeak(window_seconds=60, clock=clock)
    gauge.read(current=3)

    clock.now += 1
    assert gauge.read(current=0) == 3


def test_the_current_value_wins_when_it_exceeds_the_recorded_peak() -> None:
    """Nothing has to `record` for the gauge to stay truthful — it only adds resolution."""
    assert WindowedPeak().read(current=6) == 6


def test_a_hot_path_costs_one_entry_per_second_not_one_per_call() -> None:
    """Recording is on every queue put and every pool checkout, so it must not grow with traffic."""
    clock = _Clock()
    gauge = WindowedPeak(window_seconds=60, clock=clock)

    for value in range(500):
        gauge.record(value)
    clock.now += 1
    for value in range(500):
        gauge.record(value)

    assert len(gauge._buckets) == 2
    assert gauge.read(current=0) == 499


def test_recording_without_ever_reading_stays_bounded() -> None:
    """Nothing scrapes for an hour — a dead Prometheus, a dropped target — and the app runs on.

    Reading is what prunes, so without this the buckets grow one per second for as long as the
    outage lasts, in the one state where nobody is watching the process that holds them.
    """
    clock = _Clock()
    gauge = WindowedPeak(window_seconds=60, clock=clock)

    for _ in range(3600):
        gauge.record(1)
        clock.now += 1

    assert len(gauge._buckets) <= 120
    # Pruning must not have cost it the window it is meant to report.
    assert gauge.read(current=0) == 1


def test_pool_checkout_feeds_the_peak() -> None:
    """The listener is what makes the pool gauge see anything between scrapes."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import QueuePool

    engine = create_engine("sqlite://", poolclass=QueuePool)
    pool = engine.pool
    # The count only exists on a real pool; NullPool and StaticPool are why `_pool_reader` guards.
    assert isinstance(pool, QueuePool)

    gauge = WindowedPeak()
    event.listen(pool, "checkout", lambda *_: gauge.record(pool.checkedout()))

    first = engine.connect()
    second = engine.connect()
    first.close()
    second.close()

    # Both are back in the pool before the read, which is the case an instantaneous gauge misses.
    assert pool.checkedout() == 0
    assert gauge.read(current=pool.checkedout()) == 2


def test_module_level_peaks_are_wired_for_the_subsystems_that_feed_them() -> None:
    """`sse/manager.py` and the metrics router reach these by import; a rename must not orphan them."""
    assert isinstance(metrics.SSE_QUEUE_PEAK, WindowedPeak)
    assert isinstance(metrics.DB_POOL_PEAK, WindowedPeak)


async def test_a_failed_send_is_counted_where_nothing_else_would_notice(monkeypatch) -> None:
    """A background send fails after the response has gone, so no route ever 5xxs for it."""
    from app.services import email

    monkeypatch.setattr(email.settings, "resend_api_key", "test-key")

    async def explode(_message: email._Message) -> None:
        raise RuntimeError("Resend email request failed: unreachable")

    monkeypatch.setattr(email, "_call_resend", explode)
    before = _email_count("verification", "failed")

    await email.send_verification_email("someone@example.com", "https://example.test/verify?token=x")

    assert _email_count("verification", "failed") == before + 1


def test_a_server_error_is_countable_before_one_has_ever_happened() -> None:
    """`ServerErrors` is the rule that must not need a second failure to fire.

    The labelled counter is keyed by route, so its 5xx slice does not exist until a 5xx does. This
    twin is registered at import with no labels, which is what gives `increase()` a zero to count
    up from — on every replica, and again after each restart.
    """
    before = _server_errors()

    metrics.observe_response("GET", "/api/anything", 503)

    assert _server_errors() == before + 1


def test_a_handled_response_leaves_the_server_error_count_alone() -> None:
    before = _server_errors()

    for status in (200, 304, 401, 404, 429, 499):
        metrics.observe_response("GET", "/api/anything", status)

    assert _server_errors() == before


def _app_that_raises(exc: Exception) -> FastAPI:
    """The real mounting in miniature: `add_middleware` always lands inside ServerErrorMiddleware."""
    app = FastAPI()
    app.add_middleware(ResponseStatusMiddleware)

    @app.get("/api/boom")
    async def boom() -> None:
        raise exc

    return app


def test_a_crash_is_counted_although_the_500_is_built_above_this_middleware() -> None:
    """The case asserting on `observe_response` directly cannot reach: nothing calls it.

    An unhandled exception propagates past `send_wrapper` to ServerErrorMiddleware, which writes the
    500 where this middleware can no longer see it — so the alert named for 5xx saw only the
    deliberate ones.
    """
    client = TestClient(_app_that_raises(RuntimeError("kaboom")), raise_server_exceptions=False)
    before = _server_errors()

    assert client.get("/api/boom").status_code == 500

    assert _server_errors() == before + 1


def test_a_deliberate_500_is_counted_exactly_once() -> None:
    """The response *does* reach `send_wrapper` here, so the exception path must not count it again."""
    client = TestClient(_app_that_raises(HTTPException(status_code=500)), raise_server_exceptions=False)
    before = _server_errors()

    assert client.get("/api/boom").status_code == 500

    assert _server_errors() == before + 1


def test_the_original_exception_still_reaches_the_handler_above() -> None:
    """A bare re-raise, never `from None` — that would cost ServerErrorMiddleware the traceback it logs."""
    client = TestClient(_app_that_raises(RuntimeError("kaboom")), raise_server_exceptions=True)

    with pytest.raises(RuntimeError, match="kaboom"):
        client.get("/api/boom")


def test_a_stream_that_dies_mid_body_is_not_counted_a_second_time() -> None:
    """The whole reason the exception path is guarded, and the case SSE actually lands in.

    Its status line went out as a 200 long before the body failed, so counting the raise as well
    would report one request as two — and invent a 5xx the client was never served.
    """
    app = FastAPI()
    app.add_middleware(ResponseStatusMiddleware)

    async def body() -> AsyncIterator[bytes]:
        yield b"partial"
        raise RuntimeError("the stream went away")

    @app.get("/api/stream")
    async def stream() -> StreamingResponse:
        return StreamingResponse(body())

    client = TestClient(app, raise_server_exceptions=False)
    before = _server_errors()

    with contextlib.suppress(Exception):
        client.get("/api/stream")

    assert _server_errors() == before


def test_every_email_outcome_has_a_series_before_it_first_happens() -> None:
    """`EmailSendsFailing` alerts on an outcome that may never have occurred, which is the trap.

    A labelled child is created on first use, so without pre-creation the first failure appears as
    a series whose every sample is already 1 — and `increase()` over that is 0. The alert would
    then need a *second* failure before it could fire.
    """
    missing = [
        (operation, outcome)
        for operation in get_args(metrics.EmailOperation)
        for outcome in get_args(metrics.EmailOutcome)
        if REGISTRY.get_sample_value(
            "frontdashboard_email_sends_total",
            {"operation": operation, "outcome": outcome},
        )
        is None
    ]
    assert not missing, f"invisible until they first happen: {missing}"


def _server_errors() -> float:
    value = REGISTRY.get_sample_value("frontdashboard_http_server_errors_total")
    # Not `or 0.0`: absent and zero are the same number and opposite facts, and absent is the bug.
    assert value is not None, "no series until the first 5xx, so increase() would start from 1"
    return value


def _email_count(operation: str, outcome: str) -> float:
    value = REGISTRY.get_sample_value("frontdashboard_email_sends_total", {"operation": operation, "outcome": outcome})
    return value or 0.0
