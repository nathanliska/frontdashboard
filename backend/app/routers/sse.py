"""SSE endpoint — single multiplexed stream per authenticated user."""

import asyncio
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from app.auth.dependencies import get_current_user_for_stream
from app.models.user import User
from app.sse.events import connected_dict, resync_dict
from app.sse.manager import manager

router = APIRouter(prefix="/api/sse", tags=["sse"])


def _should_resync_on_connect(last_event_id: str | None) -> bool:
    """Any Last-Event-ID means the browser is reconnecting an existing stream."""
    return last_event_id is not None


@router.get("")
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user_for_stream),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user."""
    send_resync = _should_resync_on_connect(request.headers.get("last-event-id"))
    client = manager.connect(current_user.id, set())

    async def _generate() -> AsyncGenerator[dict, None]:
        try:
            yield connected_dict()

            if send_resync:
                yield resync_dict()

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
