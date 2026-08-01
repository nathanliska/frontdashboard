"""Process counters and Prometheus exposition rendering.

Deliberately hand-rolled: counters and gauges are a few lines of text, and a scraping client
library would be a runtime dependency for something nothing yet scrapes.

A leaf module on purpose — it imports nothing from the app, so the subsystems it counts can
import it without a cycle. Gauges are supplied by the caller, read at scrape time.

Counters live in process memory, so each WEB_CONCURRENCY worker reports its own and a scraper
sums across targets.
"""

SSE_CONNECTS = "sse_connects_total"
SSE_RESYNCS = "sse_resyncs_total"
SSE_EVICTIONS = "sse_evictions_total"
SSE_EXPIRIES = "sse_expiries_total"
HTTP_4XX = "http_4xx_total"
HTTP_5XX = "http_5xx_total"
RATE_LIMITED = "rate_limited_total"
REAPER_SWEEPS = "reaper_sweeps_total"
REAPER_FAILURES = "reaper_failures_total"

REAPER_LAST_SUCCESS = "reaper_last_success_unixtime"

_counters: dict[str, int] = {
    SSE_CONNECTS: 0,
    SSE_RESYNCS: 0,
    SSE_EVICTIONS: 0,
    SSE_EXPIRIES: 0,
    HTTP_4XX: 0,
    HTTP_5XX: 0,
    RATE_LIMITED: 0,
    REAPER_SWEEPS: 0,
    REAPER_FAILURES: 0,
}

_gauges: dict[str, int] = {
    REAPER_LAST_SUCCESS: 0,
}

_META: dict[str, tuple[str, str]] = {
    SSE_CONNECTS: ("counter", "SSE streams opened, including reconnects."),
    SSE_RESYNCS: ("counter", "Streams told to refetch every cache they hold."),
    SSE_EVICTIONS: ("counter", "Clients dropped for falling behind their queue."),
    SSE_EXPIRIES: ("counter", "Streams closed on the lifetime cap so the client reconnects."),
    HTTP_4XX: ("counter", "Responses with a 4xx status."),
    HTTP_5XX: ("counter", "Responses with a 5xx status."),
    RATE_LIMITED: ("counter", "Requests rejected by the rate limiter."),
    REAPER_SWEEPS: ("counter", "Retention sweeps that completed."),
    REAPER_FAILURES: ("counter", "Retention sweeps that raised and will retry next tick."),
    REAPER_LAST_SUCCESS: ("gauge", "Unix time of the last completed retention sweep."),
    "sse_clients": ("gauge", "SSE streams currently open."),
    "sse_queue_depth_max": ("gauge", "Deepest queue across open streams; backpressure before eviction."),
    "db_pool_checked_out": ("gauge", "Connections handed out by the pool right now."),
    "db_pool_size": ("gauge", "Connections the pool keeps open."),
    "db_pool_overflow": ("gauge", "Connections open beyond pool_size; 0 until the pool is full."),
    "db_pool_limit": ("gauge", "Hard ceiling on connections: pool_size + max_overflow."),
}

_PREFIX = "frontdashboard_"


def increment(name: str) -> None:
    """Add one to a counter, ignoring an unknown name.

    Observing a request must never be able to fail it.
    """
    if name in _counters:
        _counters[name] += 1


def observe_status(status_code: int) -> None:
    """Bucket a response status. Only the classes worth alerting on are counted."""
    if 400 <= status_code < 500:
        _counters[HTTP_4XX] += 1
    elif status_code >= 500:
        _counters[HTTP_5XX] += 1


def set_gauge(name: str, value: int) -> None:
    """Record a gauge the process knows but a scrape cannot compute, ignoring unknown names."""
    if name in _gauges:
        _gauges[name] = value


def counters() -> dict[str, int]:
    """Snapshot the counters. Callers must not mutate the result."""
    return dict(_counters)


def reset() -> None:
    """Zero every counter and stored gauge. For tests — a live process never calls this."""
    for name in _counters:
        _counters[name] = 0
    for name in _gauges:
        _gauges[name] = 0


def render(gauges: dict[str, int]) -> str:
    """Render counters plus the supplied gauges as a Prometheus exposition document.

    Raises KeyError for a gauge with no registered help text, which keeps an unnamed series
    from reaching a dashboard.
    """
    lines: list[str] = []
    for name, value in {**_counters, **_gauges, **gauges}.items():
        metric_type, help_text = _META[name]
        lines.append(f"# HELP {_PREFIX}{name} {help_text}")
        lines.append(f"# TYPE {_PREFIX}{name} {metric_type}")
        lines.append(f"{_PREFIX}{name} {value}")
    return "\n".join(lines) + "\n"
