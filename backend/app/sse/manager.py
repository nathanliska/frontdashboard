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

# Replaces a full queue's backlog. The stream generator turns it into one in-place resync frame;
# until that is dequeued, further frames are dropped — the refetch it orders covers their content.
OVERFLOW_SENTINEL = object()

# Pushed onto a client's queue when its session is revoked. Distinct from
# OVERFLOW_SENTINEL: that means "you fell behind, resync", which is wrong here — a
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
    # True from overflow until the generator dequeues the sentinel; broadcast drops frames while set.
    resync_pending: bool = False


class SseManager:
    def __init__(self) -> None:
        self._clients: list[_Client] = []

    @property
    def client_count(self) -> int:
        """Open streams on this worker. Read by metrics, which must not reach into _clients."""
        return len(self._clients)

    @property
    def max_queue_depth(self) -> int:
        """Deepest queue across open streams — backpressure, visible before it becomes overflow."""
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
            # Drained first so the sentinel always fits: a revoked stream's backlog is worthless,
            # and a full queue would otherwise swallow the one frame that ends it promptly.
            self._drain(client)
            client.queue.put_nowait(REVOKED_SENTINEL)
            self.disconnect(client)

    def deliver_to_all(self, message: dict) -> None:
        """Send one frame to every stream on this worker, regardless of who it belongs to.

        Only the fan-out reader uses this, to tell everyone here to resync after it may have
        missed frames. Ordinary events address an audience and go through `broadcast`.

        A pending overflow already queues the same instruction, so those clients are skipped
        rather than told twice; a queue this frame overflows converts to that pending state.
        """
        for client in list(self._clients):
            if client.resync_pending:
                continue
            try:
                client.queue.put_nowait(message)
            except asyncio.QueueFull:
                self._overflow(client)

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
            if client.resync_pending:
                continue
            try:
                client.queue.put_nowait(message)
                metrics.SSE_QUEUE_PEAK.record(client.queue.qsize())
            except asyncio.QueueFull:
                self._overflow(client)

    @staticmethod
    def _drain(client: _Client) -> None:
        while not client.queue.empty():
            with contextlib.suppress(asyncio.QueueEmpty):
                client.queue.get_nowait()

    def _overflow(self, client: _Client) -> None:
        """Coalesce a client too far behind into a single in-place resync.

        The backlog goes and only the overflow sentinel remains; the stream stays open and the
        generator turns the sentinel into one resync frame. Frames arriving before that clears
        are dropped — the refetch it orders covers them — so a burst costs one refetch, not a
        reconnect loop.
        """
        self._drain(client)
        client.queue.put_nowait(OVERFLOW_SENTINEL)
        client.resync_pending = True
        metrics.SSE_OVERFLOW_RESYNCS.inc()


# Module-level singleton used by routers (Step 12 wires this up)
manager = SseManager()
