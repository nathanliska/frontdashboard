"""Central API router composition and shared API paths."""

from fastapi import APIRouter

from app.routers.auth import router as auth_router
from app.routers.calendar import router as calendar_router
from app.routers.dashboards import router as dashboards_router
from app.routers.health import router as health_router
from app.routers.invites import router as invites_router
from app.routers.lists import router as lists_router
from app.routers.notifications import activity_router
from app.routers.notifications import router as notifications_router
from app.routers.sse import router as sse_router

API_PREFIX = "/api"

api_router = APIRouter(prefix=API_PREFIX)

api_router.include_router(auth_router)
api_router.include_router(calendar_router)
api_router.include_router(dashboards_router)
api_router.include_router(health_router)
api_router.include_router(invites_router)
api_router.include_router(lists_router)
api_router.include_router(notifications_router)
api_router.include_router(activity_router)
api_router.include_router(sse_router)
