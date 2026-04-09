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


@dataclass
class _Client:
    user_id: uuid.UUID
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)


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
        # Snapshot the list so mutations during awaits don't cause issues
        for client in list(self._clients):
            if user_ids:
                if client.user_id in user_ids:
                    await client.queue.put(message)
            else:
                if client.user_id == actor_id:
                    await client.queue.put(message)


# Module-level singleton used by routers (Step 12 wires this up)
manager = SseManager()
