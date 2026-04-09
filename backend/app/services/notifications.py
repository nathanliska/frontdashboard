import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification


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
