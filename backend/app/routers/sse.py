"""SSE endpoint — single multiplexed stream per authenticated user."""

import asyncio
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from app.auth.dependencies import get_current_user_for_stream
from app.models.user import User
from app.sse.events import connected_dict, resync_dict
from app.sse.manager import CLOSED_SENTINEL, _Client, manager

router = APIRouter(prefix="/sse", tags=["sse"])


def _should_resync_on_connect(last_event_id: str | None) -> bool:
    """Any Last-Event-ID means the browser is reconnecting an existing stream."""
    return last_event_id is not None


async def stream_events(client: _Client, *, send_resync: bool) -> AsyncGenerator[dict, None]:
    """Yield SSE frames for one connection until it closes or is evicted.

    Module-level (rather than nested in the route) so tests can drive it directly:
    httpx's ASGI transport cannot cleanly close an infinite SSE generator.
    """
    try:
        yield connected_dict()

        if send_resync:
            yield resync_dict()

        while True:
            try:
                msg = await asyncio.wait_for(client.queue.get(), timeout=5.0)
            except TimeoutError:
                # No event in the last 5s — loop. sse-starlette's ping=25 sends
                # keepalive comments independently.
                continue

            if msg is CLOSED_SENTINEL:
                # Evicted for falling behind: tell the client to resync and end the
                # response. EventSource reconnects and re-syncs from Last-Event-ID.
                yield resync_dict()
                return

            yield msg
    finally:
        client.manager.disconnect(client)


@router.get("")
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user_for_stream),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user."""
    send_resync = _should_resync_on_connect(request.headers.get("last-event-id"))
    client = manager.connect(current_user.id)
    return EventSourceResponse(stream_events(client, send_resync=send_resync), ping=25)
