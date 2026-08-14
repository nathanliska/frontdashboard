"""Per-creator and per-container ceilings on the tables that have no retention horizon.

Activity and notifications are pruned at 90 days; lists, items, events and dashboards are not, so
without a ceiling one account can grow the database without bound. Rate limits bound writes per
minute and deliberately not the total — a patient script stays under any sane rate limit forever.

Counts include tombstoned rows, which still occupy storage until the reaper purges them; excluding
them would make the ceiling bypassable by deleting and recreating. Which rows those are differs by
resource, so the refusal has to say what actually frees room (ADR-007, ADR-020).
"""

from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.metrics import QUOTA_REJECTIONS, QuotaResource

# How a reader frees room for this resource: at once, by emptying the trash, or only when the
# reaper passes the tombstone.
ReclaimPath = Literal["immediate", "purge", "expiry"]


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


def limit_message(noun: str, cap: int, *, reclaim: ReclaimPath) -> str:
    """Phrase a refusal so the reader knows what actually frees room.

    Naming the wrong path strands a reader at their cap doing something that cannot work, which is
    why this is a required argument rather than a default (ADR-007).
    """
    room = f"You have reached the limit of {cap:,} {noun}."
    if reclaim == "immediate":
        return f"{room} Delete some to make room."
    if reclaim == "purge":
        return f"{room} Delete some to make room — anything already in the trash keeps its space until you delete it permanently."
    return f"{room} Delete some to make room, though a deleted event keeps its space until the trash horizon passes."
