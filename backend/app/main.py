import asyncio
import logging
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api import api_router
from app.config import Environment, settings
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
        if reaper_task is not None:
            reaper_task.cancel()
            with suppress(asyncio.CancelledError):
                await reaper_task


app = FastAPI(title="FrontDashboard", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # ty: ignore[invalid-argument-type]

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
