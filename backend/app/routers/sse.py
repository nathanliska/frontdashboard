"""SSE endpoint — single multiplexed stream per authenticated user."""

import asyncio
import random
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from app import metrics
from app.auth.dependencies import get_current_session_for_stream, get_current_user_for_stream
from app.database import async_session_factory
from app.models.session import UserSession
from app.models.user import User
from app.schemas.sse import AnySseEvent
from app.services.activity import current_event_id, entity_types_changed_since
from app.services.sessions import session_is_live
from app.services.shares import list_accessible_dashboard_ids
from app.sse.events import connected_dict, resync_dict
from app.sse.manager import CLOSED_SENTINEL, REVOKED_SENTINEL, _Client, manager

router = APIRouter(prefix="/sse", tags=["sse"])

_REVALIDATE_EVERY = timedelta(seconds=30)

# A connection severed without a close handshake is never reported as disconnected — the proxy
# holds the upstream open, so writes keep succeeding and the stream would occupy a slot forever.
# Closing on a schedule bounds that; the client's mark makes the reconnect cost nothing.
_MAX_STREAM_LIFETIME = timedelta(minutes=30)


def _stream_deadline(lifetime: timedelta) -> datetime:
    """When to close this stream, spread so streams opened together don't all expire together."""
    jitter = random.uniform(0, lifetime.total_seconds() * 0.1)
    return datetime.now(UTC) + lifetime + timedelta(seconds=jitter)


def _parse_watermark(raw: str | None) -> int | None:
    """Read a client's high-water mark, treating anything unparseable as absent."""
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _resync_needed(watermark: int | None, head: int | None) -> bool:
    """Decide whether a connecting client has to refetch everything.

    A mark the log has moved past is the only thing that earns a resync. No mark means either a
    first connect, which has nothing to catch up on, or a reconnect the client resyncs itself.
    """
    if watermark is None:
        return False
    return head is not None and head > watermark


async def _connect_state(watermark: int | None, user: User) -> tuple[bool, int | None, set[str] | None]:
    """Resolve the resync decision, the log's head, and what kinds of thing changed.

    Its own short-lived session: the request's would stay pinned for the stream's lifetime.
    The head is read unfiltered — "nothing happened at all" proves nothing was missed and
    discloses no one's activity — but the scopes are filtered to dashboards this user can see,
    because naming what changed would otherwise report other households' activity.
    """
    async with async_session_factory() as db:
        head = await current_event_id(db)
        needed = _resync_needed(watermark, head)
        if not needed or watermark is None:
            return needed, head, None
        visible = await list_accessible_dashboard_ids(user, db)
        scopes = await entity_types_changed_since(db, watermark, set(visible))
    return needed, head, scopes


async def stream_events(
    client: _Client,
    *,
    send_resync: bool,
    revalidate: Callable[[uuid.UUID], Awaitable[bool]],
    watermark: int | None = None,
    max_lifetime: timedelta = _MAX_STREAM_LIFETIME,
    resync_scopes: set[str] | None = None,
) -> AsyncGenerator[dict, None]:
    """Yield SSE frames until the connection closes, is evicted, or its session is revoked.

    Module-level rather than nested in the route so tests can drive it directly: httpx's ASGI
    transport cannot cleanly close an infinite SSE generator.

    `revalidate` is injected rather than reached for. Tests override get_db to yield
    a savepoint-bound session; a revalidation that opened its own session from
    async_session_factory would bypass that override, query outside the test's
    savepoint, fail to see the session row the test just created, conclude
    "revoked", and kill the stream — every SSE test failing for a reason that looks
    nothing like the cause.
    """
    next_check = datetime.now(UTC) + _REVALIDATE_EVERY
    expires_at = _stream_deadline(max_lifetime)
    try:
        yield connected_dict(watermark)

        if send_resync:
            yield resync_dict(resync_scopes)

        while True:
            # No resync frame: the client reconnects and its mark decides, so a healthy stream
            # being recycled costs one index probe rather than a refetch of every cache.
            if datetime.now(UTC) >= expires_at:
                metrics.SSE_EXPIRIES.inc()
                return

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
                # Evicted for falling behind: tell the client to resync and end the response.
                # Its mark is stale by definition here, so the resync is sent unconditionally.
                yield resync_dict()
                return

            if msg is REVOKED_SENTINEL:
                # Session revoked. End with no resync — the client must re-auth.
                return

            yield msg
    finally:
        client.manager.disconnect(client)


async def _revalidate_session(session_id: uuid.UUID) -> bool:
    """Re-check session liveness on its own short-lived database session.

    The request's session must not stay pinned for the stream's lifetime, which is why
    `get_current_session_for_stream` uses `scope="function"`.
    """
    async with async_session_factory() as db:
        return await session_is_live(session_id, db)


@router.get("", responses={200: {"model": AnySseEvent, "content": {"text/event-stream": {}}}})
async def sse_stream(
    request: Request,
    last_event_id: str | None = None,
    current_user: User = Depends(get_current_user_for_stream),
    current_session: UserSession = Depends(get_current_session_for_stream),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user.

    The client reconnects by opening a fresh EventSource, which sends no Last-Event-ID header, so
    the query parameter is the mark that normally arrives; the header is honoured as a fallback.
    """
    watermark = _parse_watermark(last_event_id or request.headers.get("last-event-id"))
    send_resync, head, scopes = await _connect_state(watermark, current_user)
    # Counted together: the ratio is what says whether marks are sparing anyone a refetch.
    metrics.SSE_CONNECTS.inc()
    if send_resync:
        metrics.SSE_RESYNCS.inc()
    client = manager.connect(current_user.id, session_id=current_session.id)
    return EventSourceResponse(
        stream_events(
            client,
            send_resync=send_resync,
            revalidate=_revalidate_session,
            watermark=head,
            resync_scopes=scopes,
        ),
        ping=25,
    )
