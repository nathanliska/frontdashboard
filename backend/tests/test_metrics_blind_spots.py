"""Failures that no other signal would show.

`test_metrics.py` proves the endpoint serves its metrics. What it cannot prove is that they see
anything. A connection is held for milliseconds against a 15s scrape, so an instantaneous gauge
reads zero through every burst worth catching; and an email send happens in a background task
after the response has gone, so no route ever 5xxs for one that failed.
"""

from prometheus_client import REGISTRY
from sqlalchemy import event

from app import metrics
from app.metrics import WindowedPeak


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

    def explode(_message: email._Message) -> None:
        raise RuntimeError("Resend email request failed: unreachable")

    monkeypatch.setattr(email, "_call_resend", explode)
    before = _email_count("verification", "failed")

    await email.send_verification_email("someone@example.com", "https://example.test/verify?token=x")

    assert _email_count("verification", "failed") == before + 1


def _email_count(operation: str, outcome: str) -> float:
    value = REGISTRY.get_sample_value("frontdashboard_email_sends_total", {"operation": operation, "outcome": outcome})
    return value or 0.0
