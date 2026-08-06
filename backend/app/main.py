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

_LOG_HANDLER_NAME = "frontdashboard"


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
    try:
        yield
    finally:
        try:
            if reaper_task is not None:
                reaper_task.cancel()
                with suppress(asyncio.CancelledError):
                    await reaper_task
        finally:
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
