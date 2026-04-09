from fastapi import FastAPI, Request, Response
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

app = FastAPI(title="FrontDashboard")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


@app.middleware("http")
async def add_security_headers(request: Request, call_next: object) -> Response:
    response: Response = await call_next(request)  # type: ignore[operator]
    for header, value in _SECURITY_HEADERS.items():
        response.headers[header] = value
    return response


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
