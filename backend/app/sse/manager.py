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

_QUEUE_MAX = 256


@dataclass
class _Client:
    user_id: uuid.UUID
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=_QUEUE_MAX))


class SseManager:
    def __init__(self) -> None:
        self._clients: list[_Client] = []

    def connect(self, user_id: uuid.UUID) -> _Client:
        """Register a new SSE connection and return its client handle."""
        client = _Client(user_id=user_id)
        self._clients.append(client)
        return client

    def disconnect(self, client: _Client) -> None:
        """Remove a client when its SSE connection closes."""
        with contextlib.suppress(ValueError):  # double-close guard
            self._clients.remove(client)

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
            except asyncio.QueueFull:
                # Client is stalled — drop it so the generator's finally block
                # calls disconnect() when it next times out and detects closure.
                self.disconnect(client)


# Module-level singleton used by routers (Step 12 wires this up)
manager = SseManager()
