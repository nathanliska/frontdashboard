"""Notifications and activity log endpoints."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, or_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.models.activity import ActivityEvent, EventType
from app.models.notification import Notification
from app.models.user import User
from app.schemas.notifications import (
    ActivityEventResponse,
    NotificationPageResponse,
    NotificationResponse,
    UnreadCountResponse,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])

_PAGE_LIMIT = 50
# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


def _encode_cursor(notification: Notification) -> str:
    unread = "u" if notification.read_at is None else "r"
    # "|" because the ISO timestamp itself contains ":".
    return f"{unread}|{notification.created_at.isoformat()}|{notification.id}"


def _decode_cursor(cursor: str) -> tuple[bool, datetime, uuid.UUID]:
    try:
        section, created_at_raw, id_raw = cursor.split("|")
        if section not in ("u", "r"):
            raise ValueError(cursor)
        return section == "u", datetime.fromisoformat(created_at_raw), uuid.UUID(id_raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid cursor",
        ) from exc


@router.get("", response_model=NotificationPageResponse)
async def list_notifications(
    cursor: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationPageResponse:
    """One page of the caller's notifications (unread first, then read), keyset-paginated.

    The sort key is compound — unread section, then created_at, then id as the total-order
    tiebreaker (created_at ties across a batch insert). A row can move sections between pages
    (read on another device mid-scroll); keyset pagination over a mutable key can then repeat
    it, and the client's existing dedupe-by-id absorbs that rather than this endpoint trying
    to prevent it.
    """
    unread = Notification.read_at.is_(None)
    position = tuple_(Notification.created_at, Notification.id)
    q = select(Notification).where(Notification.user_id == current_user.id)

    if cursor is not None:
        in_unread_section, cursor_created_at, cursor_id = _decode_cursor(cursor)
        if in_unread_section:
            # Still walking the unread section: older unread rows, or anything already read.
            q = q.where(or_(and_(unread, position < (cursor_created_at, cursor_id)), ~unread))
        else:
            q = q.where(and_(~unread, position < (cursor_created_at, cursor_id)))

    # limit+1: fetch one row beyond the page so has-more is a fact, not a guess.
    result = await db.execute(q.order_by(unread.desc(), Notification.created_at.desc(), Notification.id.desc()).limit(_PAGE_LIMIT + 1))
    rows = list(result.scalars().all())
    page = rows[:_PAGE_LIMIT]
    next_cursor = _encode_cursor(page[-1]) if len(rows) > _PAGE_LIMIT else None
    return NotificationPageResponse(
        items=[NotificationResponse.model_validate(n) for n in page],
        next_cursor=next_cursor,
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
async def unread_count(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCountResponse:
    """Return the number of unread notifications for the caller."""
    from sqlalchemy import func

    result = await db.execute(
        select(func.count(Notification.id)).where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
    )
    return UnreadCountResponse(count=result.scalar_one())


@router.patch("/{notification_id}/read", response_model=NotificationResponse)
async def mark_read(
    notification_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationResponse:
    """Mark a single notification as read."""
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
    """Mark all unread notifications as read for the caller."""
    now = datetime.now(UTC)
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=now)
        .execution_options(synchronize_session="fetch")
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Activity log
# ---------------------------------------------------------------------------

activity_router = APIRouter(prefix="/activity", tags=["activity"])


@activity_router.get("", response_model=list[ActivityEventResponse])
async def list_activity(
    event_type: str | None = None,
    before_event_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ActivityEventResponse]:
    """Return the caller's own activity feed."""
    q = select(ActivityEvent).where(ActivityEvent.actor_id == current_user.id)

    # Hide structural churn by default so the Activity tab reads like a timeline,
    # not a transport log. Keep meaningful dashboard metadata changes visible.
    q = (
        q.where(ActivityEvent.event_type == event_type)
        if event_type is not None
        else q.where(
            ActivityEvent.event_type != EventType.list_item_checked.value,
            or_(
                ActivityEvent.event_type != EventType.dashboard_updated.value,
                ActivityEvent.payload.contains({"changed_fields": ["name"]}),
                ActivityEvent.payload.contains({"changed_fields": ["restored"]}),
            ),
        )
    )
    if before_event_id is not None:
        q = q.where(ActivityEvent.event_id < before_event_id)

    q = q.order_by(ActivityEvent.event_id.desc()).limit(_PAGE_LIMIT)
    result = await db.execute(q)
    return [ActivityEventResponse.model_validate(e) for e in result.scalars().all()]
