"""SSE connection manager.

Maintains a registry of connected clients (one queue per open SSE connection).
broadcast() fans out a pre-serialised message dict to every client that is
subscribed to the relevant group (or to the actor only for private events).

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
    group_ids: frozenset[uuid.UUID]
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)


class SseManager:
    def __init__(self) -> None:
        self._clients: list[_Client] = []

    def connect(self, user_id: uuid.UUID, group_ids: set[uuid.UUID]) -> _Client:
        """Register a new SSE connection and return its client handle."""
        client = _Client(user_id=user_id, group_ids=frozenset(group_ids))
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
        group_id: uuid.UUID | None,
        group_ids: set[uuid.UUID] | None = None,
        user_ids: set[uuid.UUID] | None = None,
        actor_id: uuid.UUID,
    ) -> None:
        """Fan out message to all eligible connected clients.

        Shared events (group_id set): delivered to every client whose membership
        set includes that group.
        Multi-group / explicit-user events: delivered once to every client whose
        membership set intersects the provided groups or whose user_id is targeted.
        Private events (group_id None): delivered only to the actor.
        """
        # Snapshot the list so mutations during awaits don't cause issues
        for client in list(self._clients):
            if group_ids or user_ids:
                if (group_ids and client.group_ids.intersection(group_ids)) or (user_ids and client.user_id in user_ids):
                    await client.queue.put(message)
            elif group_id is not None:
                if group_id in client.group_ids:
                    await client.queue.put(message)
            else:
                if client.user_id == actor_id:
                    await client.queue.put(message)


# Module-level singleton used by routers (Step 12 wires this up)
manager = SseManager()
