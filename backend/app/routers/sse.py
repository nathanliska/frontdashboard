"""SSE endpoint — single multiplexed stream per authenticated user."""

import asyncio
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from app.auth.dependencies import get_current_session_for_stream, get_current_user_for_stream
from app.database import async_session_factory
from app.models.session import UserSession
from app.models.user import User
from app.schemas.sse import AnySseEvent
from app.services.sessions import session_is_live
from app.sse.events import connected_dict, resync_dict
from app.sse.manager import CLOSED_SENTINEL, REVOKED_SENTINEL, _Client, manager

router = APIRouter(prefix="/sse", tags=["sse"])

_REVALIDATE_EVERY = timedelta(seconds=30)


def _should_resync_on_connect(last_event_id: str | None) -> bool:
    """Any Last-Event-ID means the browser is reconnecting an existing stream."""
    return last_event_id is not None


async def stream_events(
    client: _Client,
    *,
    send_resync: bool,
    revalidate: Callable[[uuid.UUID], Awaitable[bool]],
) -> AsyncGenerator[dict, None]:
    """Yield SSE frames for one connection until it closes, is evicted, or its
    session is revoked.

    Module-level (rather than nested in the route) so tests can drive it directly:
    httpx's ASGI transport cannot cleanly close an infinite SSE generator.

    `revalidate` is injected rather than reached for. Tests override get_db to yield
    a savepoint-bound session; a revalidation that opened its own session from
    async_session_factory would bypass that override, query outside the test's
    savepoint, fail to see the session row the test just created, conclude
    "revoked", and kill the stream — every SSE test failing for a reason that looks
    nothing like the cause.
    """
    next_check = datetime.now(UTC) + _REVALIDATE_EVERY
    try:
        yield connected_dict()

        if send_resync:
            yield resync_dict()

        while True:
            # Checked on BOTH branches below, before anything else. The 5s wait_for
            # is an idle timeout, not a heartbeat: a busy client never times out, so
            # a check hung off TimeoutError would never run for the clients that
            # matter most.
            if datetime.now(UTC) >= next_check:
                if not await revalidate(client.session_id):
                    return
                next_check = datetime.now(UTC) + _REVALIDATE_EVERY

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

            if msg is REVOKED_SENTINEL:
                # Session revoked. End with no resync — the client must re-auth.
                return

            yield msg
    finally:
        client.manager.disconnect(client)


async def _revalidate_session(session_id: uuid.UUID) -> bool:
    """Open a short-lived session per check: the request's DB session must not be
    pinned for the stream's lifetime (which is why get_current_session_for_stream
    uses scope="function")."""
    async with async_session_factory() as db:
        return await session_is_live(session_id, db)


@router.get("", responses={200: {"model": AnySseEvent, "content": {"text/event-stream": {}}}})
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user_for_stream),
    current_session: UserSession = Depends(get_current_session_for_stream),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user."""
    send_resync = _should_resync_on_connect(request.headers.get("last-event-id"))
    client = manager.connect(current_user.id, session_id=current_session.id)
    return EventSourceResponse(
        stream_events(client, send_resync=send_resync, revalidate=_revalidate_session),
        ping=25,
    )
