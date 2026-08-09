"""The one place a write's transaction is committed and its SSE frames are sent.

Routes used to perform this by hand at every mutating endpoint, in an order four separate
conventions described and nothing enforced: stage the event in the same transaction, build the
frame before the commit, broadcast after it, and address the right audience. Getting the order
wrong is silent — the write succeeds and other people's tabs go stale.

See [ADR-015](../../../docs/adr/ADR-015-sse-write-choreography.md).
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated

from fastapi import Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.sse import broker
from app.sse.manager import manager

# Round-trips a write to its SSE echo: the tab stamps every mutation with its per-load id, the
# payload carries it back, and the issuing tab alone suppresses frames its responses already covered.
ClientIdHeader = Annotated[str | None, Header(alias="X-Client-Id", max_length=128)]


@dataclass(frozen=True)
class Fanout:
    """One prepared frame and who receives it.

    `user_ids` of None delivers to the actor alone, which is what a private event wants.
    """

    message: dict
    user_ids: set[uuid.UUID] | None = None


async def commit_and_broadcast(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID,
    fanouts: Sequence[Fanout] = (),
) -> None:
    """Commit the route's single transaction, then send the frames it prepared.

    Frames must already be built: `build_activity_sse_dict` flushes to obtain the sequence-assigned
    `event_id`, which has to happen inside the transaction. Sending only after the commit is what
    stops a tab acting on state that then rolls back.
    """
    await db.commit()
    for fanout in fanouts:
        await manager.broadcast(fanout.message, user_ids=fanout.user_ids, actor_id=actor_id)
        # Local first, then the other workers: publishing cannot raise, so a Redis fault costs
        # sibling replicas the frame rather than costing this worker's clients theirs.
        await broker.publish(fanout.message, user_ids=fanout.user_ids, actor_id=actor_id)
