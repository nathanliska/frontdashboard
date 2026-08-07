"""Cross-process SSE fan-out over a Redis stream.

`manager` stays process-local: it knows only the clients attached to this worker. This module is
what carries a frame to the others, so a dashboard shared between two people fans out to both when
they are served by different replicas.

A stream rather than pub/sub, which is at-most-once by Redis's own definition — a subscriber that
blinks loses whatever was published meanwhile, and redis-py reconnects silently, so the loss has no
symptom. Reading from the last id seen survives that. See
[ADR-004](../../../docs/adr/ADR-004-sse-over-websocket.md).
"""

import asyncio
import contextlib
import json
import logging
import uuid
from typing import Any

import redis.asyncio as aioredis
from redis.backoff import NoBackoff
from redis.retry import Retry

from app import metrics
from app.config import settings
from app.sse.events import resync_dict
from app.sse.manager import manager

logger = logging.getLogger("app")

# Frames a worker publishes come back to it on its own subscription; this is how it tells them
# apart from a sibling's, having already delivered its own locally.
WORKER_ID = str(uuid.uuid4())

# Not tuned to a measured rate: it only has to cover a worker restart, and anything longer is
# repaired by the recovery resync rather than by history. `~` lets Redis trim on node boundaries.
_STREAM_MAXLEN = 1000
_BLOCK_MS = 5000
_RECONNECT_DELAY_SECONDS = 1.0
_PUBLISH_BACKOFF_SECONDS = 5.0

# Above the server-side block, so an idle read never trips it but a wedged connection still raises.
# A blackholed host sends no RST, and an unbounded read would leave this worker's clients missing
# every sibling frame with nothing to reconnect on — the one failure here with no symptom.
_READ_TIMEOUT_SECONDS = _BLOCK_MS / 1000 + 5

# A backstop above the 0.25s socket budget, not the main bound. Resolving a stopped container's
# hostname was measured at anywhere from 0.25s to 3.9s, so redis-py's timeouts hold most of the
# time and this caps the write path for when they do not (ADR-013).
_PUBLISH_TIMEOUT_SECONDS = 1.0

# Set on a failed publish; until then writes skip the attempt instead of each paying the timeout.
_publish_retry_after = 0.0

# Module scope rather than local to the reader, because a gauge has to be able to read it: a worker
# that cannot reach the stream still serves its own clients, so nothing else reveals the state.
_reader_degraded = False

metrics.register_gauge(
    "sse_fanout_degraded",
    "1 while this worker cannot read the stream and is missing other workers' frames.",
    lambda: float(_reader_degraded),
)


def stream_key() -> str:
    """Per environment, because a database number would not separate them: streams ignore it.

    Each stack bundles its own Redis, so this only bites once `REDIS_URL` is overridden — but a dev
    backend sharing an instance with production would otherwise deliver its events to real browsers.
    """
    return f"fd:{settings.environment.value}:sse"


def _reader_client() -> aioredis.Redis:
    """Read timeout sits above `XREAD BLOCK` rather than being disabled, so a wedge is detectable.

    Owns its reconnects rather than taking redis-py's default retry, which would paper over the
    drop this module has to notice.
    """
    return aioredis.Redis.from_url(
        settings.redis_url,
        decode_responses=True,
        socket_connect_timeout=0.25,
        socket_timeout=_READ_TIMEOUT_SECONDS,
        retry=Retry(NoBackoff(), 0),
        retry_on_error=[],
    )


_publisher: aioredis.Redis | None = None


def _publisher_client() -> aioredis.Redis:
    """Pooled and bounded, unlike the reader: this one is on the write path.

    A per-call client would pay a TCP handshake per mutation, and an unbounded read timeout would
    let a wedged Redis hold a request that has already committed.
    """
    global _publisher
    if _publisher is None:
        _publisher = aioredis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=0.25,
            socket_timeout=0.25,
            retry=Retry(NoBackoff(), 1),
        )
    return _publisher


async def close_publisher() -> None:
    global _publisher
    if _publisher is not None:
        with contextlib.suppress(Exception):
            await _publisher.aclose()
        _publisher = None


def encode(message: dict, user_ids: set[uuid.UUID] | None, actor_id: uuid.UUID) -> str:
    return json.dumps(
        {
            "origin": WORKER_ID,
            "message": message,
            "user_ids": None if user_ids is None else sorted(str(u) for u in user_ids),
            "actor_id": str(actor_id),
        }
    )


def decode(raw: str) -> tuple[dict, set[uuid.UUID] | None, uuid.UUID, str]:
    frame = json.loads(raw)
    user_ids = frame["user_ids"]
    return (
        frame["message"],
        None if user_ids is None else {uuid.UUID(u) for u in user_ids},
        uuid.UUID(frame["actor_id"]),
        frame["origin"],
    )


async def publish(message: dict, *, user_ids: set[uuid.UUID] | None, actor_id: uuid.UUID) -> None:
    """Hand a frame to the other workers.

    Never raises: the caller has already committed, so failing here would 500 a write that
    succeeded. A frame lost this way is repaired by the reconnect resync every stream takes.
    """
    global _publish_retry_after
    now = asyncio.get_running_loop().time()
    # Without this every write would pay the connect timeout again, for the length of the outage.
    # Nothing is lost by not trying: Redis is down, and the readers resync when it returns.
    if now < _publish_retry_after:
        return
    try:
        await asyncio.wait_for(
            _publisher_client().xadd(
                stream_key(),
                {"frame": encode(message, user_ids, actor_id)},
                maxlen=_STREAM_MAXLEN,
                approximate=True,
            ),
            _PUBLISH_TIMEOUT_SECONDS,
        )
        _publish_retry_after = 0.0
    except Exception:
        _publish_retry_after = now + _PUBLISH_BACKOFF_SECONDS
        metrics.SSE_PUBLISH_FAILURES.inc()
        logger.warning("SSE fan-out publish failed; siblings will not see this frame", exc_info=True)


async def _deliver(raw: str) -> None:
    message, user_ids, actor_id, origin = decode(raw)
    if origin == WORKER_ID:
        return
    await manager.broadcast(message, user_ids=user_ids, actor_id=actor_id)


async def run_subscriber(*, stop: asyncio.Event | None = None) -> None:
    """Read the stream forever, delivering sibling workers' frames to local clients.

    Starts at `$`, so a worker joins at the head rather than replaying history nobody is waiting
    for. After a read error it resumes from the last id it saw, and tells local clients to resync,
    because a stream that was unreachable may also have been trimmed past that id.
    """
    global _reader_degraded
    last_id = "$"
    _reader_degraded = False
    while stop is None or not stop.is_set():
        client = None
        try:
            # Inside the try: `from_url` raises on a malformed REDIS_URL, and letting that escape
            # would end this task for the life of the worker — serving traffic, reading nothing.
            client = _reader_client()
            while stop is None or not stop.is_set():
                # redis-py types this as a scalar union; the wire shape is [(key, [(id, fields)])].
                response: Any = await client.xread({stream_key(): last_id}, count=100, block=_BLOCK_MS)
                if _reader_degraded:
                    # On the way back, not on the way down: the reader may have missed frames while
                    # it was away, and a client can only act on that once it is being served again.
                    # Once per outage — resyncing on every failed retry would refetch everything on
                    # every connected tab, every second, for as long as Redis stayed down.
                    _reader_degraded = False
                    logger.warning("SSE fan-out reader reconnected; resyncing local clients")
                    manager.deliver_to_all(resync_dict())
                for _key, entries in response or []:
                    for entry_id, fields in entries:
                        last_id = entry_id
                        frame = fields.get("frame")
                        if frame:
                            await _deliver(frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not _reader_degraded:
                _reader_degraded = True
                logger.warning("SSE fan-out reader cannot reach Redis", exc_info=True)
            await asyncio.sleep(_RECONNECT_DELAY_SECONDS)
        finally:
            if client is not None:
                with contextlib.suppress(Exception):
                    await client.aclose()
