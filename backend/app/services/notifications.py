"""Notification creation service.

maybe_notify() inspects an ActivityEvent and creates Notification rows for
every eligible recipient (actor-suppressed, coalesced).  It must be called
before db.commit() so everything lands in the same transaction.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from app.models.group import GroupMember
from app.models.notification import Notification

# Only these event types create inbox notifications
INBOX_WORTHY: frozenset[str] = frozenset(
    {
        "membership.added",
        "membership.removed",
    }
)

# Notifications of the same type for the same group within this window are coalesced
_COALESCE_MINUTES = 5


async def maybe_notify(db: AsyncSession, event: ActivityEvent) -> list[Notification]:
    """Create (or coalesce) Notification rows for an inbox-worthy event.

    Returns the list of Notification objects added to the session.
    Caller must commit the session afterward.
    """
    if event.event_type not in INBOX_WORTHY:
        return []
    if event.group_id is None:
        return []

    # All active members of the group except the actor (actor suppression)
    mem_result = await db.execute(
        select(GroupMember.user_id).where(
            GroupMember.group_id == event.group_id,
            GroupMember.left_at.is_(None),
            GroupMember.user_id != event.actor_id,
        )
    )
    recipient_ids: list[uuid.UUID] = [row[0] for row in mem_result.all()]
    if not recipient_ids:
        return []

    title, body = _format(event)
    cutoff = datetime.now(UTC) - timedelta(minutes=_COALESCE_MINUTES)

    created: list[Notification] = []
    for user_id in recipient_ids:
        # Coalescing: look for a recent unread notification of the same type
        existing_result = await db.execute(
            select(Notification)
            .where(
                Notification.user_id == user_id,
                Notification.type == event.event_type,
                Notification.group_id == event.group_id,
                Notification.read_at.is_(None),
                Notification.created_at >= cutoff,
            )
            .limit(1)
        )
        existing = existing_result.scalar_one_or_none()
        if existing is not None:
            # Update body to reflect the latest event; link to new activity event
            existing.body = body
            existing.activity_event_id = event.id
            created.append(existing)
        else:
            notif = Notification(
                user_id=user_id,
                group_id=event.group_id,
                activity_event_id=event.id,
                type=event.event_type,
                title=title,
                body=body,
                reference_type=event.entity_type,
                reference_id=event.entity_id,
            )
            db.add(notif)
            created.append(notif)

    return created


def _format(event: ActivityEvent) -> tuple[str, str]:
    actor = event.actor_display_name
    if event.event_type == "membership.added":
        return "New member", f"{actor} joined the group"
    if event.event_type == "membership.removed":
        reason = event.payload.get("reason", "removed") if event.payload else "removed"
        if reason == "left":
            return "Member left", f"{actor} left the group"
        return "Member removed", f"{actor} was removed from the group"
    return "Notification", event.event_type
