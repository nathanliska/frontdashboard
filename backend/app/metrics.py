"""Process metrics, on the Prometheus client library.

A leaf module on purpose — it imports nothing from the app, so the subsystems it measures can
import it without a cycle. Gauges whose value is only knowable at scrape time are registered with
a callback rather than pushed, so nothing has to remember to update them.

Counters live in this process. With `WEB_CONCURRENCY > 1` each worker keeps its own and a scraper
sums across targets; the library's multiprocess mode is the alternative if that stops being enough,
and it needs `PROMETHEUS_MULTIPROC_DIR` plus explicit gauge aggregation.
"""

from collections.abc import Callable

from prometheus_client import Counter, Gauge, Histogram, disable_created_metrics

# Every counter and histogram otherwise publishes a `_created` timestamp gauge nobody queries —
# a third of this app's series. In code rather than the documented env var, because the repo never
# reaches the deployment host and an env var there would be one more thing to hand-sync.
disable_created_metrics()

_PREFIX = "frontdashboard_"

SSE_CONNECTS = Counter(f"{_PREFIX}sse_connects", "SSE streams opened, including reconnects.")
SSE_RESYNCS = Counter(f"{_PREFIX}sse_resyncs", "Streams told to refetch caches on connect.")
SSE_EVICTIONS = Counter(f"{_PREFIX}sse_evictions", "Clients dropped for falling behind their queue.")
SSE_EXPIRIES = Counter(f"{_PREFIX}sse_expiries", "Streams closed on the lifetime cap.")
REAPER_SWEEPS = Counter(f"{_PREFIX}reaper_sweeps", "Retention sweeps that completed.")
REAPER_FAILURES = Counter(f"{_PREFIX}reaper_failures", "Retention sweeps that raised and will retry.")
RATE_LIMITED = Counter(f"{_PREFIX}rate_limited", "Requests rejected by the rate limiter.")

# Labelled by route *template*, never the raw path: /dashboards/{id} is one series, not one per
# dashboard. Status class rather than code keeps a 404 storm from minting series for each variant.
HTTP_RESPONSES = Counter(
    f"{_PREFIX}http_responses",
    "Responses served, by route template and status class.",
    ["method", "route", "status_class"],
)

# Labelled by route but *not* method, unlike the response counter: every label multiplies by the
# bucket count, and route is what you investigate when something is slow. Timed to the response
# *start*, so an SSE stream that stays open for half an hour is measured on its headers.
HTTP_REQUEST_SECONDS = Histogram(
    f"{_PREFIX}http_request_seconds",
    "Time to begin the response, by route template.",
    ["route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)

SSE_EVENTS_SENT = Counter(f"{_PREFIX}sse_events_sent", "Frames written to a client — fan-out actually delivered.")

# Straddles the 30-minute lifetime cap and its 10% jitter, so healthy streams land in the top
# buckets. Connect counts alone cannot tell twenty healthy streams from twenty flapping ones.
SSE_STREAM_SECONDS = Histogram(
    f"{_PREFIX}sse_stream_seconds",
    "How long a stream stayed open before it closed, for any reason.",
    buckets=(1, 5, 15, 60, 300, 900, 1500, 1800, 2100),
)

REAPER_LAST_SUCCESS = Gauge(
    f"{_PREFIX}reaper_last_success_unixtime",
    "Unix time of the last completed retention sweep; staleness means the sweep died.",
)

# `reason` splits unknown_user from bad_password, which is the distinction the login timing
# equalizer deliberately hides. Safe only while both hold: the counts are aggregate, so no single
# address is ever resolvable, and `/metrics` sits outside `/api` where Caddy cannot route to it.
AUTH_FAILURES = Counter(
    f"{_PREFIX}auth_failures",
    "Rejected authentication attempts, by surface and cause.",
    ["operation", "reason"],
)

# An Argon2 hash costs a near-constant floor, so the spread above it is queueing for the
# concurrency limiter. A gauge alone would miss that — saturation is bursty and scrapes are not.
# Boundaries straddle a measured 34ms verify on the deployment host: too coarse and every healthy
# operation lands in one bucket, which is a histogram with no resolution at all.
ARGON2_SECONDS = Histogram(
    f"{_PREFIX}argon2_seconds",
    "Argon2 operation latency, including time queued for a limiter slot.",
    ["operation"],
    buckets=(0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)


def observe_response(method: str, route: str, status_code: int, *, seconds: float | None = None) -> None:
    """Count one response, and time it when the caller measured. Never raises."""
    HTTP_RESPONSES.labels(method=method, route=route, status_class=f"{status_code // 100}xx").inc()
    if seconds is not None:
        HTTP_REQUEST_SECONDS.labels(route=route).observe(seconds)


def register_gauge(name: str, documentation: str, reader: Callable[[], float]) -> Gauge:
    """Register a gauge evaluated at scrape time.

    For values the process can always answer but never needs to push — pool occupancy, open
    streams — so no code path has to remember to keep them current.
    """
    gauge = Gauge(f"{_PREFIX}{name}", documentation)
    gauge.set_function(reader)
    return gauge
