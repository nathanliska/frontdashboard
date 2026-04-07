"""SSE event serialisation helpers."""

import json
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from app.models.notification import Notification


def activity_to_sse_dict(event: ActivityEvent) -> dict:
    """Convert an ActivityEvent ORM row to the dict format expected by
    EventSourceResponse (keys: data, event, id)."""
    payload = {
        "event_id": event.event_id,
        "event_type": event.event_type,
        "group_id": str(event.group_id) if event.group_id else None,
        "entity_type": event.entity_type,
        "entity_id": str(event.entity_id),
        "entity_version": event.entity_version,
        "actor_id": str(event.actor_id),
        "actor_display_name": event.actor_display_name,
        "payload": event.payload,
        "created_at": event.created_at.isoformat(),
    }
    return {
        "id": str(event.event_id),
        "event": event.event_type,
        "data": json.dumps(payload),
    }


async def build_activity_sse_dict(db: AsyncSession, event: ActivityEvent) -> dict:
    """Flush and refresh a staged ActivityEvent before serialising it for SSE."""
    await db.flush()
    await db.refresh(event)
    return activity_to_sse_dict(event)


def connected_dict() -> dict:
    """Prime EventSource with a Last-Event-ID even before domain events arrive."""
    return {
        "id": "connected",
        "event": "connected",
        "data": json.dumps({}),
    }


def resync_dict() -> dict:
    return {
        "event": "resync",
        "data": json.dumps({"reason": "refresh_required"}),
    }


def notification_to_sse_dict(notif: Notification) -> dict:
    """Serialize a Notification for delivery via SSE as 'notification.created'."""
    payload = {
        "id": str(notif.id),
        "type": notif.type,
        "title": notif.title,
        "body": notif.body,
        "group_id": str(notif.group_id) if notif.group_id else None,
        "reference_type": notif.reference_type,
        "reference_id": str(notif.reference_id) if notif.reference_id else None,
        "read_at": notif.read_at.isoformat() if notif.read_at else None,
        "created_at": notif.created_at.isoformat(),
    }
    return {
        "event": "notification.created",
        "data": json.dumps(payload),
    }


async def build_notification_sse_dict(db: AsyncSession, notif: Notification) -> dict:
    """Flush and refresh a staged Notification before serialising it for SSE."""
    await db.flush()
    await db.refresh(notif)
    return notification_to_sse_dict(notif)


async def build_notification_sse_dicts(db: AsyncSession, notifications: Sequence[Notification]) -> list[dict]:
    """Materialise a batch of notifications for SSE with a single session flush."""
    if not notifications:
        return []

    await db.flush()
    messages: list[dict] = []
    for notif in notifications:
        await db.refresh(notif)
        messages.append(notification_to_sse_dict(notif))
    return messages
