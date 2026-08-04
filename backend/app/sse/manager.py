"""SSE connection manager.

Maintains a registry of connected clients (one queue per open SSE connection).
broadcast() fans out a pre-serialised message dict to targeted users, or to the
actor only for private events.

Thread-safety: the manager runs inside a single asyncio event loop. List
mutations (append/remove) happen outside of await points, so no explicit lock
is needed under asyncio's cooperative multitasking model.
"""

import asyncio
import contextlib
import uuid
from dataclasses import dataclass, field

from app import metrics

_QUEUE_MAX = 256

# Pushed onto a client's queue when it is evicted for falling too far behind.
# The stream generator ends the response on this, so the client reconnects and the resync it is
# sent restores consistency — its mark is stale by definition once events have been dropped.
CLOSED_SENTINEL = object()

# Pushed onto a client's queue when its session is revoked. Distinct from
# CLOSED_SENTINEL: that means "you fell behind, resync", which is wrong here — a
# revoked client that resynced would fire a burst of GETs that all 401 and end at
# /login anyway. This ends the stream with no resync frame, so the client
# reconnects, 401s, fails to refresh, and goes to /login directly.
REVOKED_SENTINEL = object()


@dataclass
class _Client:
    user_id: uuid.UUID
    session_id: uuid.UUID
    manager: SseManager
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=_QUEUE_MAX))


class SseManager:
    def __init__(self) -> None:
        self._clients: list[_Client] = []

    @property
    def client_count(self) -> int:
        """Open streams on this worker. Read by metrics, which must not reach into _clients."""
        return len(self._clients)

    @property
    def user_count(self) -> int:
        """Distinct users holding a stream — people online, where client_count is browser tabs.

        Each tab opens its own EventSource, so one person reading on a laptop and a phone with two
        tabs each is four clients and one user. Fan-out cost tracks the former, "is anyone else
        around" the latter.
        """
        return len({client.user_id for client in self._clients})

    @property
    def max_queue_depth(self) -> int:
        """Deepest queue across open streams — backpressure, visible before it becomes eviction."""
        return max((client.queue.qsize() for client in self._clients), default=0)

    def connect(self, user_id: uuid.UUID, *, session_id: uuid.UUID) -> _Client:
        """Register a new SSE connection and return its client handle."""
        client = _Client(user_id=user_id, session_id=session_id, manager=self)
        self._clients.append(client)
        return client

    def disconnect(self, client: _Client) -> None:
        """Remove a client when its SSE connection closes."""
        with contextlib.suppress(ValueError):  # double-close guard
            self._clients.remove(client)

    def disconnect_session(self, session_id: uuid.UUID) -> None:
        """Drop every stream belonging to a revoked session.

        A latency optimisation, NOT the guarantee: stream_events revalidates on a
        deadline regardless, so a missed call here costs up to 30s of staleness
        rather than correctness. That ordering is deliberate — it keeps this
        method's single-worker assumption out of the security argument.
        """
        for client in list(self._clients):
            if client.session_id != session_id:
                continue
            with contextlib.suppress(asyncio.QueueFull):
                client.queue.put_nowait(REVOKED_SENTINEL)
            self.disconnect(client)

    async def broadcast(
        self,
        message: dict,
        *,
        user_ids: set[uuid.UUID] | None = None,
        actor_id: uuid.UUID,
    ) -> None:
        """Fan out message to all eligible connected clients.

        Targeted events are delivered to every client whose user_id is in the
        supplied audience set. Private events are delivered only to the actor.
        """
        # Snapshot the list so mutations during iteration don't cause issues.
        for client in list(self._clients):
            if user_ids:
                if client.user_id not in user_ids:
                    continue
            elif client.user_id != actor_id:
                continue
            try:
                client.queue.put_nowait(message)
                metrics.SSE_QUEUE_PEAK.record(client.queue.qsize())
            except asyncio.QueueFull:
                # Too far behind to catch up: drop the backlog and leave only a
                # close sentinel, so the generator ends the stream and the client
                # reconnects + resyncs instead of silently receiving nothing.
                while not client.queue.empty():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        client.queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    client.queue.put_nowait(CLOSED_SENTINEL)
                self.disconnect(client)
                metrics.SSE_EVICTIONS.inc()


# Module-level singleton used by routers (Step 12 wires this up)
manager = SseManager()
