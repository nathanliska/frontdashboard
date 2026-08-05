"""Process metrics, on the Prometheus client library.

A leaf module on purpose — it imports nothing from the app, so the subsystems it measures can
import it without a cycle. Gauges whose value is only knowable at scrape time are registered with
a callback rather than pushed, so nothing has to remember to update them.

Counters live in this process, so scale comes from replicas — each is its own scrape target. Forked
workers share one socket and cannot be, and multiprocess mode reports 0 for the `set_function`
gauges `register_gauge` builds; `docs/TODO.md` carries the reasoning.
"""

import contextlib
from collections.abc import Callable
from time import monotonic
from typing import Literal, get_args

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

# Unlabelled twin of the 5xx slice below, and the only one an alert can be built on: route is
# unbounded, so the labelled counter has no 5xx series until the first one — born already at 1,
# where `increase()` has nothing behind it to diff against. See docs/runbooks/rollback.md.
HTTP_SERVER_ERRORS = Counter(f"{_PREFIX}http_server_errors", "Responses served with a 5xx status.")

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

# A send happens in a background task after the response has gone, so a failure is invisible to
# every other signal here: the caller already got its 2xx and no route ever 5xxs.
EmailOperation = Literal["verification", "password_reset", "existing_account"]
EmailOutcome = Literal["sent", "outbox", "failed", "dropped"]

EMAIL_SENDS = Counter(
    f"{_PREFIX}email_sends",
    "Transactional email attempts, by kind and outcome.",
    ["operation", "outcome"],
)

# Every combination exists from import, because the client library creates a labelled child on
# first use — and a counter whose first sample is already 1 gives `increase()` nothing to diff
# against, so an alert on a rare outcome cannot see it happen for the first time.
for _operation in get_args(EmailOperation):
    for _outcome in get_args(EmailOutcome):
        EMAIL_SENDS.labels(operation=_operation, outcome=_outcome)

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

# The pairs that can actually occur, not the cross product: 6 operations by 11 reasons is 66
# series of which 50 are unreachable, and a panel of permanent zeroes reads like coverage.
# `test_auth_failure_coverage.py` fails the build when the code raises a pair missing here.
AUTH_FAILURE_PAIRS = frozenset(
    {
        ("csrf", "origin_rejected"),
        ("csrf", "token_missing"),
        ("csrf", "token_mismatch"),
        ("email_verify", "already_verified"),
        ("email_verify", "invalid_token"),
        ("email_verify", "superseded_token"),
        ("email_verify", "unknown_user"),
        ("login", "bad_password"),
        ("login", "unknown_user"),
        ("login", "unverified_email"),
        ("password_change", "bad_password"),
        ("password_reset", "invalid_token"),
        ("password_reset", "unknown_user"),
        ("session", "no_cookie"),
        ("session", "not_resolvable"),
        ("session", "unverified_email"),
    }
)

for _op, _reason in AUTH_FAILURE_PAIRS:
    AUTH_FAILURES.labels(operation=_op, reason=_reason)

# The denominator for a failure *ratio*, which is what distinguishes an attack from a household
# mistyping a password — raw failure volume cannot. Unlabelled so the series is always present and
# costs no cardinality; `auth_failures{operation="login"}` is its numerator.
LOGIN_SUCCESSES = Counter(f"{_PREFIX}login_successes", "Logins that issued a session.")

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
    """Count one response, and time it when the caller measured.

    Never raises, and enforced rather than asserted: this runs inside the ASGI send path, so an
    instrumentation fault has to cost a measurement rather than the response being measured.
    """
    with contextlib.suppress(Exception):
        HTTP_RESPONSES.labels(method=method, route=route, status_class=f"{status_code // 100}xx").inc()
        if status_code >= 500:
            HTTP_SERVER_ERRORS.inc()
        if seconds is not None:
            HTTP_REQUEST_SECONDS.labels(route=route).observe(seconds)


# Must outlast the scrape interval, or a burst can still fall between two scrapes and be missed.
# Longer costs only that a spike is reported by several consecutive scrapes rather than one.
_PEAK_WINDOW_SECONDS = 60.0


class WindowedPeak:
    """Highest value seen in the last `window_seconds`, for a quantity that is transient by nature.

    A connection is held for milliseconds and a queue drains in one tick, so a gauge sampled every
    15s reads zero through the bursts it exists to catch. Whatever holds one of these has to
    `record` on the path that makes the value rise; nothing else needs to know.

    Reading adds to the window but never discards from it, so a scrape is safe to repeat: an HA
    Prometheus pair, or one server plus a `curl` while debugging, all see the same peak. Draining
    on read would hand each of them a different fraction of the same burst.
    """

    def __init__(self, window_seconds: float = _PEAK_WINDOW_SECONDS, *, clock: Callable[[], float] = monotonic) -> None:
        self._window = window_seconds
        self._clock = clock
        # Keyed by whole second, so a hot path recording thousands of times still costs one entry
        # per second of window rather than one per call.
        self._buckets: dict[int, float] = {}

    def record(self, value: float) -> None:
        """Note a value the quantity just reached."""
        second = int(self._clock())
        if value > self._buckets.get(second, 0.0):
            self._buckets[second] = value
        # Reading is what normally bounds this, so nothing does while nothing is scraping — the one
        # state in which a bucket per second forever would also go unnoticed. Amortised: the sweep
        # runs once per window at most, not once per call.
        if len(self._buckets) > 2 * self._window:
            self._expire()

    def read(self, current: float) -> float:
        """Report the window's peak, counting a value still held right now.

        `current` is recorded rather than only compared, which is what carries a level across a
        quiet window: connections open at this scrape are still the peak at the next one.
        """
        self.record(current)
        self._expire()
        return max(self._buckets.values(), default=0.0)

    def _expire(self) -> None:
        cutoff = self._clock() - self._window
        self._buckets = {second: value for second, value in self._buckets.items() if second >= cutoff}


# Owned here so the code that makes the value rise can reach them without importing a router.
SSE_QUEUE_PEAK = WindowedPeak()
DB_POOL_PEAK = WindowedPeak()


def register_gauge(name: str, documentation: str, reader: Callable[[], float]) -> Gauge:
    """Register a gauge evaluated at scrape time.

    For values the process can always answer but never needs to push — pool occupancy, open
    streams — so no code path has to remember to keep them current.
    """
    gauge = Gauge(f"{_PREFIX}{name}", documentation)
    gauge.set_function(reader)
    return gauge
