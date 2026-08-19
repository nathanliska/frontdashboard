import asyncio
import logging
import os
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import IntegrityError

from app import metrics
from app.api import api_router
from app.config import Environment, settings
from app.database import engine
from app.limiter import limiter
from app.middleware import ResponseStatusMiddleware
from app.routers.metrics import router as metrics_router
from app.services.retention import reaper_loop
from app.sse.broker import close_publisher, run_subscriber

_LOG_HANDLER_NAME = "frontdashboard"

# Endpoints only a prober calls: the container HEALTHCHECK, the metrics scrape, and the external
# uptime checks that reach /api/health/ready through Caddy (observability/README.md).
_PROBE_PATHS = frozenset({"/api/health", "/api/health/ready", "/metrics"})


class ProbeAccessFilter(logging.Filter):
    """Treat access lines for healthy probe endpoints as debug-level detail.

    A 60s HEALTHCHECK, a metrics scrape and the external uptime checks outweigh real traffic on
    a household-sized deployment, and none of those lines carries information above `debug`:
    container health is in `docker inspect .State.Health`, a stalled scrape shows up as
    Prometheus's own `up`, and an external prober keeps its own history — which, unlike a log
    line, can be alerted on. A failing probe is still logged; that is when the line is worth it.

    Only `debug` and `info` reach this at all: uvicorn writes access lines through
    `logger.info`, so `warning` and above drop every line, probe or not, before any filter.
    """

    def __init__(self) -> None:
        super().__init__()
        # Resolved once: LOG_LEVEL is process config and this runs per request line. Same
        # tolerant lookup as _configure_app_logging, so a typo'd level falls back the same way.
        self._keep_all = getattr(logging, settings.log_level.upper(), logging.INFO) <= logging.DEBUG

    def filter(self, record: logging.LogRecord) -> bool:
        if self._keep_all:
            return True
        # uvicorn's access record carries (client_addr, method, full_path, http_version, status).
        # Anything else is a shape we don't recognise, and an unreadable line is still a line.
        if not isinstance(record.args, tuple) or len(record.args) != 5:
            return True
        full_path, status = record.args[2], record.args[4]
        if not isinstance(full_path, str) or not isinstance(status, int):
            return True
        return status >= 400 or full_path.split("?", 1)[0] not in _PROBE_PATHS


def _configure_app_logging() -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    formatter = logging.Formatter("%(levelname)s:%(name)s:%(message)s")
    # slowapi is here because losing the rate-limit store is otherwise silent: it says so once, on
    # its own logger, which ships a no-op handler — so the app serves on per-process limits looking
    # entirely healthy. Never quieter than WARNING, so raising LOG_LEVEL cannot hide it.
    for name, floor in (("app", level), ("slowapi", min(level, logging.WARNING))):
        logger = logging.getLogger(name)
        logger.setLevel(floor)
        logger.propagate = False
        # By name, not emptiness: slowapi has already attached its own discarding handler.
        if not any(h.get_name() == _LOG_HANDLER_NAME for h in logger.handlers):
            handler = logging.StreamHandler(sys.stdout)
            handler.set_name(_LOG_HANDLER_NAME)
            handler.setFormatter(formatter)
            logger.addHandler(handler)

    # Added here rather than through uvicorn's log config because uvicorn applies that config
    # before importing the app, so anything set there would be overwritten by it, not after it.
    access_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, ProbeAccessFilter) for f in access_logger.filters):
        access_logger.addFilter(ProbeAccessFilter())


_configure_app_logging()


def _requested_worker_count() -> int:
    """Read the worker count someone asked for, which is not the one uvicorn runs."""
    try:
        return int(os.environ.get("WEB_CONCURRENCY", "1"))
    except ValueError:
        return 1


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    logger = logging.getLogger("app")
    if settings.environment == Environment.production:
        logger.info("Starting: environment=production (Secure cookies ON, production config validated)")
    else:
        logger.warning(
            "Starting: environment=%s (Secure cookies OFF, production validation skipped)",
            settings.environment.value,
        )
    # Nothing acts on this; scale comes from replicas. Warned rather than dropped, so asking for
    # workers is not a silent no-op.
    if _requested_worker_count() > 1:
        logger.warning(
            "WEB_CONCURRENCY=%d is ignored; this container runs one worker. Scale with replicas.",
            _requested_worker_count(),
        )
    reaper_task: asyncio.Task[None] | None = None
    if settings.reaper_enabled:
        reaper_task = asyncio.create_task(reaper_loop())
    # Unconditional: a worker that does not read the stream is one whose clients silently miss
    # every change made on another replica.
    fanout_task = asyncio.create_task(run_subscriber())
    app.state.fanout_task = fanout_task
    try:
        yield
    finally:
        try:
            for task in (reaper_task, fanout_task):
                if task is not None:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
        finally:
            await close_publisher()
            await engine.dispose()


app = FastAPI(title="FrontDashboard", lifespan=lifespan)

app.state.limiter = limiter


def count_rate_limited(request: Request, exc: Exception) -> Response:
    """Count a rejection, then answer with slowapi's own response.

    Wrapped rather than replaced: the 429 body and Retry-After stay slowapi's to define.
    """
    metrics.RATE_LIMITED.inc()
    return _rate_limit_exceeded_handler(request, exc)  # ty: ignore[invalid-argument-type]


app.add_exception_handler(RateLimitExceeded, count_rate_limited)


async def handle_integrity_error(request: Request, exc: IntegrityError) -> JSONResponse:
    """Answer an unhandled constraint violation with 409 rather than 500.

    Every write is schema-validated first, so a violation reaching the database means two
    requests disagreed about current state — a conflict the client can resolve by refetching.
    Logged with the traceback: a route hitting this often enough deserves its own handler.
    """
    logging.getLogger("app").error("IntegrityError escaped route handling on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={"detail": "That change conflicts with one made concurrently. Refresh and try again."},
    )


app.add_exception_handler(IntegrityError, handle_integrity_error)  # ty: ignore[invalid-argument-type]

app.add_middleware(ResponseStatusMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
# Outside api_router's /api prefix deliberately — see routers/metrics.py for why that is the
# access control.
app.include_router(metrics_router)
