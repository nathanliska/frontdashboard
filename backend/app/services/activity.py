"""Activity event logging service.

log_event() adds an ActivityEvent to the current DB session without committing.
The caller is responsible for committing — this keeps the event in the same
transaction as the mutation that triggered it.
"""

import uuid

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
    group_id: uuid.UUID | None = None,
    entity_version: int = 1,
    payload: dict | None = None,
) -> ActivityEvent:
    """Stage an ActivityEvent. Must be followed by db.commit() in the caller."""
    event = ActivityEvent(
        event_type=str(event_type),
        group_id=group_id,
        actor_id=actor_id,
        actor_display_name=actor_display_name,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_version=entity_version,
        payload=payload or {},
    )
    db.add(event)
    return event
