import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.limiter import limiter
from app.routers.auth import router as auth_router
from app.routers.calendar import router as calendar_router
from app.routers.dashboards import router as dashboards_router
from app.routers.lists import router as lists_router
from app.routers.notifications import activity_router
from app.routers.notifications import router as notifications_router
from app.routers.sse import router as sse_router
from app.routers.users import router as users_router


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

app = FastAPI(title="FrontDashboard")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # ty: ignore[invalid-argument-type]

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(calendar_router)
app.include_router(dashboards_router)
app.include_router(lists_router)
app.include_router(notifications_router)
app.include_router(activity_router)
app.include_router(sse_router)
app.include_router(users_router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
