import secrets
from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.session import UserSession
from app.models.user import User
from app.services.sessions import resolve_session, slide_idle_clock


@dataclass
class AuthContext:
    """The caller's live session and user, resolved together from the session cookie."""

    session: UserSession
    user: User


async def _resolve_auth_context(
    session_token: str | None,
    db: AsyncSession,
) -> AuthContext:
    """Resolve the session cookie, or 401.

    One indistinguishable answer for every way authentication can fail — no cookie, unknown
    token, revoked session, idled out, past its absolute expiry, deleted user. The client only
    ever needs to know "log in again", and a more specific message would tell an attacker
    probing tokens which of those they hit.
    """
    if not session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    resolved = await resolve_session(session_token, db)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is no longer valid")
    session, user = resolved

    # Committing here is safe *because* this is a dependency: it runs before the route body, so
    # the transaction holds nothing but this one UPDATE. A GET never commits on its own, and
    # without a commit a user who only reads would never slide their own idle clock.
    if await slide_idle_clock(session, db):
        await db.commit()

    return AuthContext(session=session, user=user)


async def get_auth_context(
    session: Annotated[str | None, Cookie(alias=settings.session_cookie_name)] = None,
    db: AsyncSession = Depends(get_db),
) -> AuthContext:
    """The single query behind every authenticated route.

    FastAPI caches dependencies by callable per request, so the cheap derivations
    below (`get_current_user`, `get_current_session`) all share this one resolution
    no matter how many of them a route pulls in.
    """
    return await _resolve_auth_context(session, db)


async def get_auth_context_for_stream(
    session: Annotated[str | None, Cookie(alias=settings.session_cookie_name)] = None,
    db: AsyncSession = Depends(get_db, scope="function"),
) -> AuthContext:
    """Authenticate long-lived streaming responses without holding the DB session open for the stream lifetime."""
    return await _resolve_auth_context(session, db)


async def get_current_user(ctx: AuthContext = Depends(get_auth_context)) -> User:
    return ctx.user


async def get_current_session(ctx: AuthContext = Depends(get_auth_context)) -> UserSession:
    return ctx.session


async def get_current_user_for_stream(ctx: AuthContext = Depends(get_auth_context_for_stream)) -> User:
    return ctx.user


async def get_current_session_for_stream(ctx: AuthContext = Depends(get_auth_context_for_stream)) -> UserSession:
    return ctx.session


async def require_csrf(
    x_csrf_token: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie(alias=settings.csrf_cookie_name)] = None,
    _user: User = Depends(get_current_user),
) -> None:
    """Double-submit CSRF check, on every non-GET route.

    There used to be a session-less variant of this for `/auth/refresh`, which could not depend on
    `get_current_user` because it existed precisely for the case where the access token had
    expired. With no refresh endpoint there is no such caller left, so authentication and the CSRF
    check are once again the same gate.
    """
    if not csrf_token or not x_csrf_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token missing")
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token invalid")
