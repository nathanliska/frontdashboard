"""Notifications and activity log endpoints."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.models.activity import ActivityEvent
from app.models.notification import Notification
from app.models.user import User
from app.schemas.notifications import ActivityEventResponse, NotificationResponse

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

_PAGE_LIMIT = 50


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationResponse]:
    """Return the caller's most recent notifications (unread first, then read)."""
    result = await db.execute(
        select(Notification)
        .where(Notification.user_id == current_user.id)
        .order_by(Notification.read_at.is_(None).desc(), Notification.created_at.desc())
        .limit(_PAGE_LIMIT)
    )
    return [NotificationResponse.model_validate(n) for n in result.scalars().all()]


@router.get("/unread-count")
async def unread_count(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from sqlalchemy import func

    result = await db.execute(
        select(func.count(Notification.id)).where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
    )
    return {"count": result.scalar_one()}


@router.patch("/{notification_id}/read", response_model=NotificationResponse)
async def mark_read(
    notification_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationResponse:
    result = await db.execute(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == current_user.id,
        )
    )
    notif = result.scalar_one_or_none()
    if notif is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")

    if notif.read_at is None:
        notif.read_at = datetime.now(UTC)
        await db.commit()

    return NotificationResponse.model_validate(notif)


@router.patch("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_read(
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Notification).where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
    )
    now = datetime.now(UTC)
    for notif in result.scalars().all():
        notif.read_at = now
    await db.commit()


# ---------------------------------------------------------------------------
# Activity log
# ---------------------------------------------------------------------------

activity_router = APIRouter(prefix="/api/activity", tags=["activity"])


@activity_router.get("", response_model=list[ActivityEventResponse])
async def list_activity(
    event_type: str | None = None,
    before_event_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ActivityEventResponse]:
    """Return the caller's own activity feed."""
    q = select(ActivityEvent).where(
        ActivityEvent.group_id.is_(None),
        ActivityEvent.actor_id == current_user.id,
    )

    if event_type is not None:
        q = q.where(ActivityEvent.event_type == event_type)
    if before_event_id is not None:
        q = q.where(ActivityEvent.event_id < before_event_id)

    q = q.order_by(ActivityEvent.event_id.desc()).limit(_PAGE_LIMIT)
    result = await db.execute(q)
    return [ActivityEventResponse.model_validate(e) for e in result.scalars().all()]
