import asyncio
import logging
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import IntegrityError

from app.api import api_router
from app.config import Environment, settings
from app.database import engine
from app.limiter import limiter
from app.services.retention import reaper_loop


def _configure_app_logging() -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    app_logger = logging.getLogger("app")
    app_logger.setLevel(level)
    app_logger.propagate = False
    if not app_logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
        app_logger.addHandler(handler)


_configure_app_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    logger = logging.getLogger("app")
    if settings.environment == Environment.production:
        logger.info("Starting: environment=production (Secure cookies ON, production config validated)")
    else:
        logger.warning(
            "Starting: environment=%s (Secure cookies OFF, production validation skipped)",
            settings.environment.value,
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
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # ty: ignore[invalid-argument-type]


async def handle_integrity_error(request: Request, exc: IntegrityError) -> JSONResponse:
    """Constraint violations that escape route-level handling are concurrency conflicts, not bugs
    the user caused — every write is schema-validated first, so what reaches the database and
    fails is two requests disagreeing about current state (finding #26). A 409 tells the client
    "refetch and retry"; the old generic 500 told it nothing. Logged with the traceback because a
    site that hits this often enough deserves its own targeted handler (like add_widget's).
    """
    logging.getLogger("app").error("IntegrityError escaped route handling on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={"detail": "That change conflicts with one made concurrently. Refresh and try again."},
    )


app.add_exception_handler(IntegrityError, handle_integrity_error)  # ty: ignore[invalid-argument-type]

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
