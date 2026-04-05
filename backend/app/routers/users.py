from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/search")
async def search_users(
    q: str = Query(min_length=1, max_length=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, str]]:
    result = await db.execute(
        select(User)
        .where(
            User.id != current_user.id,
            or_(
                User.display_name.ilike(f"%{q}%"),
                User.email.ilike(f"%{q}%"),
            ),
        )
        .order_by(User.display_name)
        .limit(10)
    )
    users = result.scalars().all()
    return [{"id": str(user.id), "display_name": user.display_name, "email": user.email} for user in users]
