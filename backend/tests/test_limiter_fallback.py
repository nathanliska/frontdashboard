"""The limiter keeps enforcing when Redis is unreachable.

Both alternatives are worse and neither is obvious from the configuration alone: the slowapi default
re-raises, so every write becomes a 500, and `swallow_errors` lets them through unbounded — which on
an internet-open registration would drop the login, reset-token and email-bomb limits at once.
"""

import io
import logging

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from redis.retry import Retry
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.limiter import STORAGE_OPTIONS, client_ip_key

pytestmark = pytest.mark.unit

# Nothing listens here, so every call to the store fails to connect.
_DEAD_REDIS = "redis://127.0.0.1:6399/0"


def _handle_rate_limited(request: Request, exc: Exception) -> Response:
    # Typed as main.py types its own, so `add_exception_handler` matches starlette's signature.
    return _rate_limit_exceeded_handler(request, exc)  # ty: ignore[invalid-argument-type]


def _app_with_dead_store() -> TestClient:
    limiter = Limiter(
        key_func=client_ip_key,
        storage_uri=_DEAD_REDIS,
        storage_options=STORAGE_OPTIONS,
        in_memory_fallback_enabled=True,
    )
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _handle_rate_limited)
    app.add_middleware(SlowAPIMiddleware)

    @app.post("/write")
    @limiter.limit("2/minute")
    async def write(request: Request) -> dict[str, bool]:
        return {"ok": True}

    return TestClient(app)


def test_an_unreachable_store_does_not_stop_the_app_starting() -> None:
    """Constructing against a dead Redis must not raise, or the fallback never gets a chance."""
    client = _app_with_dead_store()

    assert client.post("/write").status_code == 200


def test_limits_still_apply_when_redis_is_unreachable() -> None:
    """The third call is refused, not served (fail-open) and not 500 (the slowapi default)."""
    client = _app_with_dead_store()

    codes = [client.post("/write").status_code for _ in range(3)]

    assert codes == [200, 200, 429], f"expected the third write refused, got {codes}"


def test_a_lost_rate_limit_store_is_not_silent() -> None:
    """Slowapi announces the fallback once, on a logger it ships a discarding handler for.

    Unhandled, the deployment drops to per-process limits and looks entirely healthy — there is no
    error, no failed request and no metric, so nothing else would ever say so.
    """
    import app.main  # noqa: F401  — importing is what installs the handler

    logger = logging.getLogger("slowapi")
    handler = next(h for h in logger.handlers if isinstance(h, logging.StreamHandler) and h.get_name() == "frontdashboard")
    captured = io.StringIO()
    original, handler.stream = handler.stream, captured
    try:
        logger.warning("Rate limit storage unreachable - falling back to in-memory storage")
    finally:
        handler.stream = original

    assert "Rate limit storage unreachable" in captured.getvalue()


def test_the_store_cannot_stall_a_write_for_long() -> None:
    """Asserted on the options rather than the clock: a refused port fails fast either way.

    Measured against a blackholed address, which is what a downed host actually does: redis-py's
    default ten retries with exponential backoff cost 5.43s, and these bounds cost 0.50s.
    """
    retry = STORAGE_OPTIONS["retry"]

    assert STORAGE_OPTIONS["socket_connect_timeout"] <= 0.5
    assert STORAGE_OPTIONS["socket_timeout"] <= 0.5
    assert isinstance(retry, Retry)
    assert retry._retries <= 1, "redis-py retries ten times by default, which is the whole problem"
