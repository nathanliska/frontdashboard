"""SSE event serialisation helpers."""

import json
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from app.models.notification import Notification


def activity_to_sse_dict(event: ActivityEvent) -> dict:
    """Convert an ActivityEvent row to the dict EventSourceResponse expects.

    Keys: data, event, id.
    """
    payload = {
        "event_id": event.event_id,
        "event_type": event.event_type,
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
    """Flush a staged ActivityEvent, then serialise it for SSE.

    `eager_defaults=True` brings `created_at` back in the INSERT's RETURNING, but the
    sequence-assigned `event_id` is not eager-fetched (verified empirically — a plain flush
    leaves it unloaded, and lazy-loading it during serialisation raises MissingGreenlet), so it
    is refreshed by name. One targeted SELECT per *mutation* is constant cost; the N+1 this file
    used to carry was the full per-recipient refresh in the notification batch below (#25).
    """
    await db.flush()
    await db.refresh(event, attribute_names=["event_id"])
    return activity_to_sse_dict(event)


def connected_dict(last_event_id: int | None = None) -> dict:
    """Prime the client with the activity log's high-water mark.

    The mark is the frame's own id as well as its data: a client that goes on to see no domain
    event still knows where it came in, and can ask on reconnect whether it missed anything.
    """
    frame = {
        "event": "connected",
        "data": json.dumps({"last_event_id": last_event_id}),
    }
    if last_event_id is not None:
        frame["id"] = str(last_event_id)
    return frame


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
    """Flush a staged Notification, then serialise it for SSE (see build_activity_sse_dict)."""
    await db.flush()
    return notification_to_sse_dict(notif)


async def build_notification_sse_dicts(db: AsyncSession, notifications: Sequence[Notification]) -> list[dict]:
    """Materialise a batch of notifications for SSE with a single session flush.

    One flush covers the whole batch and nothing more is needed: every serialised Notification
    field is assigned in Python at staging (id is a client-side uuid4, created_at is set by
    stage_notification), so the per-notification `db.refresh` this used to do was one SELECT per
    share member of the dashboard being broadcast to, fetching nothing new (finding #25).
    """
    if not notifications:
        return []

    await db.flush()
    return [notification_to_sse_dict(notif) for notif in notifications]
