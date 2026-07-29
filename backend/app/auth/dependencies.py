import logging
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

logger = logging.getLogger("app.auth")


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


def _normalize_origin(origin: str) -> str:
    return origin.strip().rstrip("/").lower()


# Where a state-changing request may legitimately come from. `frontend_base_url` is the canonical
# origin in every environment; `cors_origins_list` widens it. Deliberately *not* branched on
# environment: a rule that only runs in production is a rule no test executes, which is exactly how
# the 2026-07-28 cookie-name bug shipped. The cost is that reaching a dev server over the LAN
# (`vite --host`, testing on a phone) needs that origin in CORS_ORIGINS, because the browser then
# sends its LAN address rather than localhost. Rejections are logged with the offending origin,
# since that is otherwise a 403 with nothing to go on.
_ALLOWED_ORIGINS = frozenset(_normalize_origin(origin) for origin in (settings.frontend_base_url, *settings.cors_origins_list))


async def require_csrf(
    x_csrf_token: Annotated[str | None, Header()] = None,
    origin: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie(alias=settings.csrf_cookie_name)] = None,
    _user: User = Depends(get_current_user),
) -> None:
    """Origin check plus the double-submit cookie, on every non-GET route.

    `Origin` is a forbidden header, so script cannot set it: a value that isn't ours means a
    cross-site caller no matter what the cookies say. It is checked *in addition to* the token
    pair, not instead of it — a request that omits `Origin` entirely still has to satisfy the
    double-submit, so turning this on cannot lock out a client that would otherwise have worked.

    That ordering matters more than it looks. Origin is stateless, which is exactly what the CSRF
    cookie is not: the 2026-07-28 outage happened because that cookie could go stale under a
    rename. Should the token pair ever be retired, this is the check that would stand alone.

    There used to be a session-less variant of this for `/auth/refresh`, which could not depend on
    `get_current_user` because it existed precisely for the case where the access token had
    expired. With no refresh endpoint there is no such caller left, so authentication and the CSRF
    check are once again the same gate.
    """
    if origin is not None and _normalize_origin(origin) not in _ALLOWED_ORIGINS:
        # The response stays generic; the log carries the origin. In production this is the only
        # trace of a cross-site attempt, and in development it is the difference between "403" and
        # "your LAN address is not in CORS_ORIGINS".
        logger.warning("Rejected a state-changing request from origin %r", origin)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-origin request rejected")
    if not csrf_token or not x_csrf_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token missing")
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token invalid")
