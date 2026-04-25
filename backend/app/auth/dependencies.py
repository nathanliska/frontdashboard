import secrets
import uuid
from typing import Annotated

import jwt
from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import decode_access_token
from app.database import get_db
from app.models.user import User


async def _resolve_current_user(
    access_token: str | None,
    db: AsyncSession,
) -> User:
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_access_token(access_token)
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from None

    result = await db.execute(select(User).where(User.id == user_id, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


async def get_current_user(
    access_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    return await _resolve_current_user(access_token, db)


async def get_current_user_for_stream(
    access_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db, scope="function"),
) -> User:
    """Authenticate long-lived streaming responses without holding the DB session open for the stream lifetime."""
    return await _resolve_current_user(access_token, db)


async def require_csrf(
    x_csrf_token: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie()] = None,
    _user: User = Depends(get_current_user),
) -> None:
    if not csrf_token or not x_csrf_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token missing")
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token invalid")
