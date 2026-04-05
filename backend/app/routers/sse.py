"""SSE endpoint — single multiplexed stream per authenticated user."""

import asyncio
import contextlib
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.activity import ActivityEvent
from app.models.user import User
from app.sse.events import activity_to_sse_dict, needs_resync, resync_dict
from app.sse.manager import manager

router = APIRouter(prefix="/api/sse", tags=["sse"])


@router.get("")
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user."""
    parsed_last_id: int | None = None
    raw_last_id = request.headers.get("last-event-id")
    if raw_last_id is not None:
        with contextlib.suppress(ValueError):
            parsed_last_id = int(raw_last_id)

    replay_messages: list[dict] = []
    send_resync = False

    if parsed_last_id is not None:
        max_result = await db.execute(select(func.max(ActivityEvent.event_id)))
        current_max: int = max_result.scalar_one() or 0

        if needs_resync(parsed_last_id, current_max):
            send_resync = True
        else:
            replay_result = await db.execute(select(ActivityEvent).where(ActivityEvent.event_id > parsed_last_id).order_by(ActivityEvent.event_id))
            for event in replay_result.scalars().all():
                if event.group_id is None and event.actor_id == current_user.id:
                    replay_messages.append(activity_to_sse_dict(event))

    client = manager.connect(current_user.id, set())

    async def _generate() -> AsyncGenerator[dict, None]:
        try:
            if send_resync:
                yield resync_dict()
            else:
                for msg in replay_messages:
                    yield msg

            while True:
                try:
                    msg = await asyncio.wait_for(client.queue.get(), timeout=5.0)
                    yield msg
                except TimeoutError:
                    # No event in the last 5s — yield nothing and loop.
                    # sse-starlette's ping=25 sends keepalive comments independently.
                    continue
        finally:
            manager.disconnect(client)

    return EventSourceResponse(_generate(), ping=25)
