"""Failures that no other signal would show.

`test_metrics.py` proves the endpoint serves its metrics. What it cannot prove is that they see
anything. A connection is held for milliseconds against a 15s scrape, so an instantaneous gauge
reads zero through every burst worth catching; and an email send happens in a background task
after the response has gone, so no route ever 5xxs for one that failed.
"""

from prometheus_client import REGISTRY
from sqlalchemy import event

from app import metrics
from app.metrics import PeakGauge


def test_a_burst_between_reads_survives_to_the_next_one() -> None:
    gauge = PeakGauge()

    gauge.record(4)
    gauge.record(7)
    gauge.record(2)

    # Everything is finished and released by the time the scrape lands.
    assert gauge.read(current=0) == 7


def test_a_quiet_interval_reports_nothing_left_over() -> None:
    """A peak belongs to its own interval, or one spike reads as permanent saturation."""
    gauge = PeakGauge()
    gauge.record(9)
    gauge.read(current=0)

    assert gauge.read(current=0) == 0


def test_a_resource_still_held_never_reads_as_free() -> None:
    """Resetting to zero would report an in-use pool as idle on the very next scrape."""
    gauge = PeakGauge()
    gauge.record(5)

    assert gauge.read(current=3) == 5
    assert gauge.read(current=3) == 3


def test_a_level_held_into_an_interval_is_not_forgotten_when_it_drops() -> None:
    """The distinguishing case for resetting to `current` rather than to zero.

    Three connections held when a scrape lands are still held as the next interval opens, so that
    interval's peak is three even if they are all released and nothing new is ever recorded.
    """
    gauge = PeakGauge()
    gauge.read(current=3)

    assert gauge.read(current=0) == 3


def test_the_current_value_wins_when_it_exceeds_the_recorded_peak() -> None:
    """Nothing has to `record` for the gauge to stay truthful — it only adds resolution."""
    assert PeakGauge().read(current=6) == 6


def test_pool_checkout_feeds_the_peak() -> None:
    """The listener is what makes the pool gauge see anything between scrapes."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import QueuePool

    engine = create_engine("sqlite://", poolclass=QueuePool)
    pool = engine.pool
    # The count only exists on a real pool; NullPool and StaticPool are why `_pool_reader` guards.
    assert isinstance(pool, QueuePool)

    gauge = PeakGauge()
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
    assert isinstance(metrics.SSE_QUEUE_PEAK, PeakGauge)
    assert isinstance(metrics.DB_POOL_PEAK, PeakGauge)


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
