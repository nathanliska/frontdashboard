"""Prometheus scrape endpoint.

Mounted outside the `/api` prefix on purpose, and that placement is the access control: Caddy
proxies only `/api/*` to this service, so a public request for `/metrics` falls through to the SPA
and is answered with `index.html`, never reaching here. The prod container also publishes no port,
so the only route in is the Docker network. Moving this under `/api` would publish connection
counts and activity volume to anyone.
"""

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app import metrics
from app.config import settings
from app.database import engine
from app.sse.manager import manager

router = APIRouter()


def _pool_reader(attribute: str) -> float:
    """Read one pool statistic, tolerating a pool implementation that lacks it.

    NullPool and StaticPool implement none of these, and a scrape must degrade rather than 500.
    """
    reader = getattr(engine.pool, attribute, None)
    if reader is None:
        return 0
    try:
        return float(reader())
    except (AttributeError, TypeError, ValueError):
        return 0


def _overflow() -> float:
    """SQLAlchemy counts overflow up from -pool_size, so the raw value is negative until full."""
    return max(0.0, _pool_reader("overflow"))


metrics.register_gauge("sse_clients", "SSE streams currently open.", lambda: manager.client_count)
metrics.register_gauge(
    "sse_queue_depth_max",
    "Deepest queue across open streams; backpressure before it becomes eviction.",
    lambda: manager.max_queue_depth,
)
metrics.register_gauge("db_pool_checked_out", "Connections handed out right now.", lambda: _pool_reader("checkedout"))
metrics.register_gauge("db_pool_size", "Connections the pool keeps open.", lambda: _pool_reader("size"))
metrics.register_gauge("db_pool_overflow", "Connections open beyond pool_size.", _overflow)
metrics.register_gauge(
    "db_pool_limit",
    "Hard ceiling on connections: pool_size + max_overflow.",
    lambda: settings.db_pool_size + settings.db_max_overflow,
)


@router.get("/metrics", response_class=PlainTextResponse, include_in_schema=False)
async def scrape() -> PlainTextResponse:
    """Expose the registry in Prometheus exposition format."""
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)
