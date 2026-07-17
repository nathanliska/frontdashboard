import secrets
import uuid
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import decode_access_token
from app.database import get_db
from app.models.session import UserSession
from app.models.user import User


@dataclass
class AuthContext:
    """The caller's live session and user, resolved together from one access token."""

    session: UserSession
    user: User


async def _resolve_auth_context(
    access_token: str | None,
    db: AsyncSession,
) -> AuthContext:
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_access_token(access_token)
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (jwt.PyJWTError, KeyError, ValueError):
        # A token minted before sessions existed has no `sid` and lands here (KeyError).
        # 401 is correct: its refresh token was deleted by the migration, so the client
        # refreshes, fails, and re-logs in.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from None

    # Both entities in one round trip: the user lookup already had to join sessions,
    # so selecting the session row alongside it costs nothing extra.
    result = await db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.id == session_id,
            UserSession.revoked_at.is_(None),
            User.id == user_id,
            User.deleted_at.is_(None),
        )
    )
    row = result.one_or_none()
    if row is None:
        # The token decoded, but its session is revoked / gone or the user is deleted.
        # "User not found" was misleading — the common case is a revoked session.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is no longer valid")
    session, user = row
    return AuthContext(session=session, user=user)


async def get_auth_context(
    access_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> AuthContext:
    """The single decode + single query behind every authenticated route.

    FastAPI caches dependencies by callable per request, so the cheap derivations
    below (`get_current_user`, `get_current_session`) all share this one resolution
    no matter how many of them a route pulls in.
    """
    return await _resolve_auth_context(access_token, db)


async def get_auth_context_for_stream(
    access_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db, scope="function"),
) -> AuthContext:
    """Authenticate long-lived streaming responses without holding the DB session open for the stream lifetime."""
    return await _resolve_auth_context(access_token, db)


async def get_current_user(ctx: AuthContext = Depends(get_auth_context)) -> User:
    return ctx.user


async def get_current_session(ctx: AuthContext = Depends(get_auth_context)) -> UserSession:
    return ctx.session


async def get_current_user_for_stream(ctx: AuthContext = Depends(get_auth_context_for_stream)) -> User:
    return ctx.user


async def get_current_session_for_stream(ctx: AuthContext = Depends(get_auth_context_for_stream)) -> UserSession:
    return ctx.session


async def require_csrf_without_session(
    x_csrf_token: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie()] = None,
) -> None:
    """Double-submit CSRF check with no access-token requirement.

    /auth/refresh exists precisely because the access token has expired, so it
    cannot depend on get_current_user the way require_csrf does.
    """
    if not csrf_token or not x_csrf_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token missing")
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token invalid")


async def require_csrf(
    x_csrf_token: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie()] = None,
    _user: User = Depends(get_current_user),
) -> None:
    await require_csrf_without_session(x_csrf_token, csrf_token)
