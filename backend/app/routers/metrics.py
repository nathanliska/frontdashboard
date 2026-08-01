"""Prometheus scrape endpoint.

Mounted outside the `/api` prefix on purpose, and that placement is the access control: Caddy
proxies only `/api/*` to this service, so a public request for `/metrics` falls through to the
SPA and is answered with `index.html`, never reaching here. The prod container also publishes no
port, so the only route in is the Docker network. Moving this under `/api` would publish
connection counts and activity volume to anyone.
"""

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app import metrics
from app.config import settings
from app.database import engine
from app.sse.manager import manager

router = APIRouter()

# Prometheus negotiates on this exact type; text/plain alone renders but does not parse.
_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def _pool_gauges() -> dict[str, int]:
    """Read pool occupancy, skipping anything this pool implementation lacks.

    NullPool and StaticPool implement none of these, so a scrape must degrade rather than 500.
    """
    pool = engine.pool
    gauges: dict[str, int] = {}
    for name, attribute in (
        ("db_pool_checked_out", "checkedout"),
        ("db_pool_size", "size"),
        ("db_pool_overflow", "overflow"),
    ):
        reader = getattr(pool, attribute, None)
        if reader is None:
            continue
        try:
            gauges[name] = int(reader())
        except (AttributeError, TypeError, ValueError):
            continue

    # SQLAlchemy counts overflow from -pool_size upward, so the raw value is negative until the
    # pool is full and reads as nonsense on a dashboard. Only genuine overflow is interesting.
    if "db_pool_overflow" in gauges:
        gauges["db_pool_overflow"] = max(0, gauges["db_pool_overflow"])
    # Published so a saturation ratio needs no hardcoded denominator in the query.
    gauges["db_pool_limit"] = settings.db_pool_size + settings.db_max_overflow
    return gauges


@router.get("/metrics", response_class=PlainTextResponse, include_in_schema=False)
async def scrape() -> PlainTextResponse:
    """Expose counters and live gauges in Prometheus exposition format."""
    gauges = {
        "sse_clients": manager.client_count,
        "sse_queue_depth_max": manager.max_queue_depth,
        **_pool_gauges(),
    }
    return PlainTextResponse(metrics.render(gauges), media_type=_CONTENT_TYPE)
