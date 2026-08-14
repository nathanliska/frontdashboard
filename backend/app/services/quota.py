"""Per-creator and per-container ceilings on the tables that have no retention horizon.

Activity and notifications are pruned at 90 days; lists, items, events and dashboards are not, so
without a ceiling one account can grow the database without bound. Rate limits bound writes per
minute and deliberately not the total — a patient script stays under any sane rate limit forever.

Counts include trashed rows. A trashed row still occupies storage until the reaper purges it, so
excluding it would make the ceiling bypassable by deleting and recreating; `DELETE` on an already
trashed resource purges it outright, which is how space is reclaimed before then (ADR-020).
"""

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.metrics import QUOTA_REJECTIONS, QuotaResource


async def assert_under_quota(
    db: AsyncSession,
    *,
    model: Any,
    resource: QuotaResource,
    cap: int,
    scope: ColumnElement[bool],
    detail: str,
) -> None:
    """Raise 422 when `scope` already holds `cap` rows of `model`.

    The count stops at the cap rather than counting everything the scope holds, so the cost of the
    check does not grow with how full the account is. Deliberately unlocked: two concurrent creates
    can both pass at cap-1 and overshoot by one, which is meaningless for a storage bound and not
    worth serialising every create to prevent.

    Raises:
        HTTPException: 422 when the scope is full.
    """
    capped = select(literal(1)).select_from(model).where(scope).limit(cap).subquery()
    count = await db.scalar(select(func.count()).select_from(capped)) or 0
    if count >= cap:
        QUOTA_REJECTIONS.labels(resource=resource).inc()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


def limit_message(noun: str, cap: int) -> str:
    """Phrase a refusal so the reader knows the trash counts and how to reclaim it."""
    return (
        f"You have reached the limit of {cap:,} {noun}. Delete some to make room — items in the "
        "trash still count until they are purged, so deleting them again removes them for good."
    )
