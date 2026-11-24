"""Health endpoints.

Two questions, deliberately separate: *is the process alive* (liveness) and *can it actually serve
a request* (readiness). Collapsing them means either a database outage reports healthy, or a
transient outage looks like a crashed process.
"""

import logging

import anyio
import asyncpg
from fastapi import APIRouter, Response, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, SQLAlchemyError

from app.config import settings
from app.database import engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: str


class ReadinessResponse(BaseModel):
    status: str
    database: bool


@router.get("", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness: the process is up and serving.

    Touches nothing, on purpose. A dependency being down does not mean this process should be
    replaced, and answering "am I alive" must never depend on the thing that might be broken.
    """
    return HealthResponse(status="ok")


@router.get("/ready", response_model=ReadinessResponse, responses={503: {"model": ReadinessResponse}})
async def ready(response: Response) -> ReadinessResponse:
    """Readiness: a request needing the database would succeed right now.

    Bounded, because the failure this exists to catch is a database that *hangs* rather than one
    that refuses — an unbounded probe would hang with it and report nothing at all. The timeout
    also covers pool exhaustion, since acquiring a connection is part of what is under test.

    The cause of a failure goes to the log, never the body: the endpoint is public.
    """
    try:
        with anyio.fail_after(settings.health_ready_timeout_seconds):
            async with engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
    # TimeoutError first: it is an OSError, and carries no message to report.
    except TimeoutError:
        logger.warning("readiness: database check timed out (limit %ss)", settings.health_ready_timeout_seconds)
    # asyncpg's own errors arrive unwrapped from opening a connection — a wrong password, a missing
    # database, a server still starting up. SQLAlchemy wraps only what a held connection raises.
    except (SQLAlchemyError, OSError, asyncpg.PostgresError, asyncpg.InterfaceError) as exc:
        # The driver's error, not SQLAlchemy's wrapper, which adds lines a log reader must stitch.
        cause = exc.orig if isinstance(exc, DBAPIError) and exc.orig is not None else exc
        logger.warning("readiness: database check failed: %s: %s", type(cause).__name__, cause)
    else:
        return ReadinessResponse(status="ready", database=True)

    response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(status="unavailable", database=False)
