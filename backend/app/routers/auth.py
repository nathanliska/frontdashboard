from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.csrf import generate_csrf_token
from app.auth.dependencies import get_current_user, require_csrf
from app.auth.hashing import hash_password, verify_password
from app.auth.tokens import create_access_token, create_opaque_token, hash_token
from app.config import settings
from app.database import get_db
from app.limiter import limiter
from app.models.dashboard import Dashboard
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.schemas.auth import LoginRequest, RegisterRequest, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])

_SECURE = settings.environment == "production"


def _set_auth_cookies(response: Response, access_token: str, refresh_token: str, csrf_token: str) -> None:
    response.set_cookie(
        "access_token",
        access_token,
        httponly=True,
        samesite="lax",
        secure=_SECURE,
        max_age=settings.access_token_expire_minutes * 60,
    )
    response.set_cookie(
        "refresh_token",
        refresh_token,
        httponly=True,
        samesite="lax",
        secure=_SECURE,
        max_age=settings.refresh_token_expire_days * 24 * 3600,
    )
    response.set_cookie(
        "csrf_token",
        csrf_token,
        httponly=False,
        samesite="lax",
        secure=_SECURE,
        max_age=settings.refresh_token_expire_days * 24 * 3600,
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")
    response.delete_cookie("csrf_token")


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
@limiter.limit("5/minute")
async def register(
    request: Request,
    body: RegisterRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
    )
    db.add(user)
    await db.flush()

    db.add(Dashboard(user_id=user.id))

    raw_refresh, refresh_hash = create_opaque_token()
    csrf = generate_csrf_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    await db.commit()

    access = create_access_token(user.id, user.email)
    _set_auth_cookies(response, access, raw_refresh, csrf)
    return UserResponse.model_validate(user)


@router.post("/login", response_model=UserResponse)
@limiter.limit("10/minute")
async def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    raw_refresh, refresh_hash = create_opaque_token()
    csrf = generate_csrf_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    await db.commit()

    access = create_access_token(user.id, user.email)
    _set_auth_cookies(response, access, raw_refresh, csrf)
    return UserResponse.model_validate(user)


@router.post("/refresh", response_model=UserResponse)
async def refresh_tokens(
    response: Response,
    refresh_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    now = datetime.now(UTC)
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == hash_token(refresh_token),
            RefreshToken.revoked.is_(False),
            RefreshToken.expires_at > now,
        )
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    record.revoked = True

    user_result = await db.execute(select(User).where(User.id == record.user_id, User.deleted_at.is_(None)))
    user = user_result.scalar_one_or_none()
    if not user:
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    raw_refresh, refresh_hash = create_opaque_token()
    csrf = generate_csrf_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    await db.commit()

    access = create_access_token(user.id, user.email)
    _set_auth_cookies(response, access, raw_refresh, csrf)
    return UserResponse.model_validate(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    _csrf: None = Depends(require_csrf),
    refresh_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    if refresh_token:
        result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_token(refresh_token)))
        record = result.scalar_one_or_none()
        if record:
            record.revoked = True
            await db.commit()
    _clear_auth_cookies(response)


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse.model_validate(current_user)
