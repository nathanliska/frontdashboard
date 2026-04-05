import uuid
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
from app.models.share import PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    PasswordChangeRequest,
    PreferencesUpdate,
    ProfileUpdate,
    RegisterRequest,
    UserResponse,
)

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


def _set_access_cookie(response: Response, access_token: str) -> None:
    response.set_cookie(
        "access_token",
        access_token,
        httponly=True,
        samesite="lax",
        secure=_SECURE,
        max_age=settings.access_token_expire_minutes * 60,
    )


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

    # Pre-generate the dashboard UUID so we can store it in preferences immediately,
    # without needing an extra flush to retrieve the auto-generated ID.
    dashboard_id = uuid.uuid4()
    db.add(Dashboard(id=dashboard_id, user_id=user.id, name="My Dashboard"))
    user.preferences = {"home_dashboard_id": str(dashboard_id)}

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
    await db.refresh(user)

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


@router.patch("/profile", response_model=UserResponse)
async def update_profile(
    body: ProfileUpdate,
    response: Response,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    if body.email is None and body.display_name is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="No profile changes provided",
        )

    if body.email is not None and body.email != current_user.email:
        result = await db.execute(
            select(User.id).where(
                User.email == body.email,
                User.id != current_user.id,
                User.deleted_at.is_(None),
            )
        )
        if result.scalar_one_or_none() is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
        current_user.email = body.email

    if body.display_name is not None:
        display_name = body.display_name.strip()
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Display name cannot be empty",
            )
        current_user.display_name = display_name

    await db.commit()
    await db.refresh(current_user)
    _set_access_cookie(response, create_access_token(current_user.id, current_user.email))
    return UserResponse.model_validate(current_user)


@router.patch("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChangeRequest,
    response: Response,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    if body.current_password == body.new_password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="New password must be different from the current password",
        )

    current_user.password_hash = hash_password(body.new_password)
    await db.commit()
    _set_access_cookie(response, create_access_token(current_user.id, current_user.email))


@router.patch("/preferences", response_model=UserResponse)
async def update_preferences(
    body: PreferencesUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Update the current user's preferences (e.g. home dashboard).

    Validates that home_dashboard_id (if provided) belongs to a dashboard
    the user can actually access, then merges the update into the JSONB column.
    """
    if body.home_dashboard_id is not None:
        try:
            dashboard_uuid = uuid.UUID(body.home_dashboard_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Invalid dashboard ID",
            ) from None

        result = await db.execute(select(Dashboard).where(Dashboard.id == dashboard_uuid))
        dashboard = result.scalar_one_or_none()
        if not dashboard:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

        # Personal dashboard — must be owned by this user
        if dashboard.user_id != current_user.id:
            share_result = await db.execute(
                select(ResourceShare.id).where(
                    ResourceShare.resource_type == ResourceType.dashboard,
                    ResourceShare.resource_id == dashboard.id,
                    ResourceShare.principal_type == PrincipalType.user,
                    ResourceShare.principal_id == current_user.id,
                )
            )
            if share_result.scalar_one_or_none() is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    # Merge update into existing preferences so other keys are preserved.
    # exclude_unset=True ensures fields not sent in the request body don't overwrite existing prefs.
    current_prefs: dict = current_user.preferences or {}
    current_user.preferences = {**current_prefs, **body.model_dump(exclude_unset=True)}
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)
