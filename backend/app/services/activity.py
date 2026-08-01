"""Activity event logging service.

log_event() adds an ActivityEvent to the current DB session without committing.
The caller is responsible for committing — this keeps the event in the same
transaction as the mutation that triggered it.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent, EventType


def log_event(
    db: AsyncSession,
    *,
    event_type: EventType | str,
    actor_id: uuid.UUID,
    actor_display_name: str,
    entity_type: str,
    entity_id: uuid.UUID,
    entity_version: int = 1,
    payload: dict | None = None,
) -> ActivityEvent:
    """Stage an ActivityEvent. Must be followed by db.commit() in the caller."""
    event = ActivityEvent(
        event_type=str(event_type),
        actor_id=actor_id,
        actor_display_name=actor_display_name,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_version=entity_version,
        payload=payload or {},
    )
    db.add(event)
    return event


async def entity_types_changed_since(
    db: AsyncSession,
    last_event_id: int,
    visible_dashboard_ids: set[uuid.UUID],
    *,
    limit: int = 500,
) -> set[str] | None:
    """Return which kinds of thing changed on visible dashboards since the mark.

    None means "more than `limit` events happened", so the answer is unknown and the caller must
    fall back to resyncing everything. The scan is bounded rather than indexed on purpose: an
    expression index on the payload would tax every write to serve reconnects.
    """
    rows = (
        await db.execute(
            select(ActivityEvent.entity_type, ActivityEvent.payload)
            .where(ActivityEvent.event_id > last_event_id)
            .order_by(ActivityEvent.event_id)
            .limit(limit + 1)
        )
    ).all()

    if len(rows) > limit:
        return None

    visible = {str(dashboard_id) for dashboard_id in visible_dashboard_ids}
    return {entity_type for entity_type, payload in rows if (payload or {}).get("dashboard_id") in visible}


async def current_event_id(db: AsyncSession) -> int | None:
    """Return the log's high-water mark, or None when nothing has been logged yet.

    Uncommitted rows are invisible, so this is the newest event any client could have been sent.
    `event_id` is indexed, so the aggregate resolves to a single-row index scan.
    """
    return await db.scalar(select(func.max(ActivityEvent.event_id)))
