from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/search")
async def search_users(
    q: str = Query(min_length=2, max_length=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, str]]:
    """Search for other users by display name or email."""
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Search query must contain at least 2 characters")

    # Escape LIKE wildcards in the user-supplied term. Unescaped, `%` and `_` stay live
    # metacharacters, so q="%%" satisfies the two-character floor above and matches every
    # row — turning the search into a directory dump of names and email addresses. The
    # floor is the anti-enumeration control, so it has to survive wildcards.
    escaped_q = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    result = await db.execute(
        select(User)
        .where(
            User.id != current_user.id,
            User.deleted_at.is_(None),
            User.email_verified_at.is_not(None),
            or_(
                User.display_name.ilike(f"%{escaped_q}%", escape="\\"),
                User.email.ilike(f"%{escaped_q}%", escape="\\"),
            ),
        )
        .order_by(User.display_name)
        .limit(10)
    )
    users = result.scalars().all()
    return [{"id": str(user.id), "display_name": user.display_name, "email": user.email} for user in users]
