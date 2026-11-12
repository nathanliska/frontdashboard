import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification
from app.sse.choreography import Fanout
from app.sse.events import build_notification_sse_dicts


def stage_notification(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    type: str,
    title: str,
    body: str,
    activity_event_id: uuid.UUID | None = None,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
) -> Notification:
    notification = Notification(
        user_id=user_id,
        activity_event_id=activity_event_id,
        type=type,
        title=title,
        body=body,
        reference_type=reference_type,
        reference_id=reference_id,
        created_at=datetime.now(UTC),
    )
    db.add(notification)
    return notification


async def build_notification_messages(
    db: AsyncSession,
    notifications: list[tuple[uuid.UUID, Notification]],
) -> list[tuple[uuid.UUID, dict]]:
    if not notifications:
        return []

    messages = await build_notification_sse_dicts(
        db,
        [notification for _user_id, notification in notifications],
    )
    return [(user_id, message) for (user_id, _notification), message in zip(notifications, messages, strict=True)]


def notification_fanouts(messages: list[tuple[uuid.UUID, dict]]) -> list[Fanout]:
    """One frame per recipient: a notification is addressed, not fanned out to the audience."""
    return [Fanout(message, {user_id}) for user_id, message in messages]
