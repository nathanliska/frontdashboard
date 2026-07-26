import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.csrf import generate_csrf_token
from app.auth.dependencies import (
    get_current_session,
    get_current_user,
    require_csrf,
    require_csrf_without_session,
)
from app.auth.hashing import _DUMMY_HASH, hash_password, verify_password
from app.auth.tokens import create_access_token, create_opaque_token, hash_token
from app.config import Environment, settings
from app.database import get_db
from app.limiter import limiter
from app.models.dashboard import Dashboard
from app.models.email_verification_token import EmailVerificationToken
from app.models.password_reset_token import PasswordResetToken
from app.models.session import UserSession
from app.models.share import PrincipalType, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.auth import (
    DISPLAY_NAME_MAX_LENGTH,
    LoginRequest,
    PasswordChangeRequest,
    PasswordResetConfirmRequest,
    PasswordResetRequest,
    PreferencesUpdate,
    ProfileUpdate,
    RegisterRequest,
    RegistrationResponse,
    ResendVerificationRequest,
    UserResponse,
    VerifyEmailRequest,
)
from app.services.email import send_existing_account_email, send_password_reset_email, send_verification_email
from app.services.password_reset import consume_password_reset_token
from app.services.sessions import (
    RefreshRejected,
    drop_session_streams,
    revoke_session,
    revoke_user_sessions,
    rotate_refresh_token,
    start_session,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

_SECURE = settings.environment == Environment.production


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


async def _issue_email_verification(user: User, db: AsyncSession) -> str:
    now = datetime.now(UTC)
    await db.execute(
        update(EmailVerificationToken)
        .where(
            EmailVerificationToken.user_id == user.id,
            EmailVerificationToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    raw_token, token_hash = create_opaque_token()
    db.add(
        EmailVerificationToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=now + timedelta(hours=settings.email_verification_expire_hours),
        )
    )
    await db.flush()
    return f"{settings.frontend_base_url.rstrip('/')}/verify-email?token={raw_token}"


async def _issue_password_reset(user: User, db: AsyncSession) -> str:
    now = datetime.now(UTC)
    await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    raw_token, token_hash = create_opaque_token()
    db.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=now + timedelta(hours=settings.password_reset_expire_hours),
        )
    )
    await db.flush()
    return f"{settings.frontend_base_url.rstrip('/')}/reset-password?token={raw_token}"


async def _create_session(user: User, response: Response, db: AsyncSession) -> None:
    session, raw_refresh = await start_session(user.id, db)
    csrf = generate_csrf_token()
    access = create_access_token(user.id, user.email, session.id)
    _set_auth_cookies(response, access, raw_refresh, csrf)


async def _normalize_accessible_dashboard_ids(
    dashboard_ids: list[str],
    current_user: User,
    db: AsyncSession,
) -> list[str]:
    normalized_ids: list[str] = []
    dashboard_uuids: list[uuid.UUID] = []
    seen: set[str] = set()

    for dashboard_id in dashboard_ids:
        try:
            dashboard_uuid = uuid.UUID(dashboard_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Invalid dashboard ID",
            ) from None

        normalized_id = str(dashboard_uuid)
        if normalized_id in seen:
            continue
        seen.add(normalized_id)
        normalized_ids.append(normalized_id)
        dashboard_uuids.append(dashboard_uuid)

    if not dashboard_uuids:
        return []

    dashboard_result = await db.execute(
        select(Dashboard.id, Dashboard.user_id).where(
            Dashboard.id.in_(dashboard_uuids),
            Dashboard.archived.is_(False),
            Dashboard.deleted_at.is_(None),
        )
    )
    dashboard_rows = dashboard_result.all()
    owner_by_dashboard_id = {str(row.id): row.user_id for row in dashboard_rows}

    if len(owner_by_dashboard_id) != len(normalized_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    direct_share_dashboard_ids = [
        uuid.UUID(dashboard_id) for dashboard_id in normalized_ids if owner_by_dashboard_id[dashboard_id] != current_user.id
    ]
    if direct_share_dashboard_ids:
        share_result = await db.execute(
            select(ResourceShare.resource_id).where(
                ResourceShare.resource_type == ResourceType.dashboard,
                ResourceShare.resource_id.in_(direct_share_dashboard_ids),
                ResourceShare.principal_type == PrincipalType.user,
                ResourceShare.principal_id == current_user.id,
            )
        )
        accessible_shared_ids = {str(row[0]) for row in share_result.all()}
        if any(
            dashboard_id not in accessible_shared_ids for dashboard_id in normalized_ids if owner_by_dashboard_id[dashboard_id] != current_user.id
        ):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return normalized_ids


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=RegistrationResponse)
@limiter.limit("5/minute")
async def register(
    request: Request,
    body: RegisterRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> RegistrationResponse:
    """Create a new user and queue email verification.

    Answers identically whether or not the address already has an account (ADR-011): registration is
    open to the internet, so a distinguishable response would be a free account-existence oracle for
    anyone. The address owner still learns of the attempt — by email, which only they can read.
    """
    # Hash before the existence check so both branches pay the same dominant cost. Skipping the
    # verify on the duplicate path would reopen through timing exactly what the response closes.
    password_hash = await hash_password(body.password)

    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        background_tasks.add_task(send_existing_account_email, body.email)
        return RegistrationResponse(email=body.email)

    user = User(
        email=body.email,
        password_hash=password_hash,
        display_name=body.display_name,
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        # A case-variant row the exact-match pre-check missed; the lower(email) index caught it.
        await db.rollback()
        background_tasks.add_task(send_existing_account_email, body.email)
        return RegistrationResponse(email=body.email)

    # Pre-generate the dashboard UUID so we can store it in preferences immediately,
    # without needing an extra flush to retrieve the auto-generated ID.
    dashboard_id = uuid.uuid4()
    db.add(Dashboard(id=dashboard_id, user_id=user.id, name="My Dashboard"))
    user.preferences = {
        "home_dashboard_id": str(dashboard_id),
        "favorite_dashboard_ids": [],
    }
    verification_url = await _issue_email_verification(user, db)
    await db.commit()
    background_tasks.add_task(send_verification_email, user.email, verification_url)
    return RegistrationResponse(email=user.email)


@router.post("/verify-email", response_model=UserResponse)
@limiter.limit("10/minute")
async def verify_email(
    request: Request,
    body: VerifyEmailRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Verify an email token and start an authenticated session."""
    now = datetime.now(UTC)
    result = await db.execute(
        select(EmailVerificationToken)
        .where(
            EmailVerificationToken.token_hash == hash_token(body.token),
            EmailVerificationToken.expires_at > now,
        )
        .with_for_update()
    )
    token = result.scalar_one_or_none()
    if not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification link")

    user_result = await db.execute(select(User).where(User.id == token.user_id, User.deleted_at.is_(None)))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification link")

    if token.used_at is not None:
        if user.email_verified_at == token.used_at:
            # Replay of the link that already verified this user — never mint a new session.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already verified. Please sign in.",
            )
        # Token was superseded (e.g. a newer link was requested) without verifying it.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification link")

    token.used_at = now
    user.email_verified_at = now
    await _create_session(user, response, db)
    await db.commit()
    await db.refresh(user)
    return UserResponse.model_validate(user)


@router.post("/resend-verification", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("3/minute")
async def resend_verification(
    request: Request,
    body: ResendVerificationRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Issue a fresh verification email for an unverified account."""
    result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    if user and user.email_verified_at is None:
        verification_url = await _issue_email_verification(user, db)
        await db.commit()
        background_tasks.add_task(send_verification_email, user.email, verification_url)


@router.post("/password-reset/request", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("3/minute")
async def request_password_reset(
    request: Request,
    body: PasswordResetRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Issue a password reset email when the account exists."""
    result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    if user:
        reset_url = await _issue_password_reset(user, db)
        await db.commit()
        background_tasks.add_task(send_password_reset_email, user.email, reset_url)


@router.post("/password-reset/confirm", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("10/minute")
async def confirm_password_reset(
    request: Request,
    body: PasswordResetConfirmRequest,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Consume a reset token and replace the user's password."""
    token_user_id = await consume_password_reset_token(body.token, db)
    if token_user_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")

    user_result = await db.execute(select(User).where(User.id == token_user_id, User.deleted_at.is_(None)))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")

    user.password_hash = await hash_password(body.new_password)
    revoked_ids = await revoke_user_sessions(user.id, db)
    await db.commit()
    drop_session_streams(revoked_ids)


@router.post("/login", response_model=UserResponse)
@limiter.limit("10/minute")
async def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Authenticate a user and issue fresh session cookies."""
    result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    password_hash = user.password_hash if user else _DUMMY_HASH
    password_ok = await verify_password(body.password, password_hash)
    if not user or not password_ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if user.email_verified_at is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Email verification required")

    await _create_session(user, response, db)
    await db.commit()
    return UserResponse.model_validate(user)


@router.post("/refresh", response_model=UserResponse)
@limiter.limit("30/minute")
async def refresh_tokens(
    request: Request,
    response: Response,
    _csrf: None = Depends(require_csrf_without_session),
    refresh_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Rotate refresh credentials and issue a new access token."""
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    try:
        session, user, raw_refresh = await rotate_refresh_token(refresh_token, db)
    except RefreshRejected as exc:
        await db.commit()  # a reuse-triggered revocation must persist
        drop_session_streams([exc.revoked_session_id] if exc.revoked_session_id else [])
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token") from None

    csrf = generate_csrf_token()
    await db.commit()

    access = create_access_token(user.id, user.email, session.id)
    _set_auth_cookies(response, access, raw_refresh, csrf)
    return UserResponse.model_validate(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    _csrf: None = Depends(require_csrf),
    session: UserSession = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Revoke the current session and clear auth cookies.

    The session comes from the access token (require_csrf already authenticated it),
    so logout revokes the session even when the refresh cookie is absent.
    """
    revoked_id = await revoke_session(session.id, db)
    await db.commit()
    drop_session_streams([revoked_id] if revoked_id else [])
    _clear_auth_cookies(response)


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)) -> UserResponse:
    """Return the currently authenticated user."""
    return UserResponse.model_validate(current_user)


@router.patch("/profile", response_model=UserResponse)
async def update_profile(
    body: ProfileUpdate,
    response: Response,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    session: UserSession = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Update editable profile fields for the current user."""
    if body.display_name is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="No profile changes provided",
        )

    if body.display_name is not None:
        display_name = body.display_name.strip()
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Display name cannot be empty",
            )
        if len(display_name) > DISPLAY_NAME_MAX_LENGTH:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Display name must be at most {DISPLAY_NAME_MAX_LENGTH} characters",
            )
        current_user.display_name = display_name

    session.last_used_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(current_user)
    _set_access_cookie(response, create_access_token(current_user.id, current_user.email, session.id))
    return UserResponse.model_validate(current_user)


@router.patch("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChangeRequest,
    response: Response,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    session: UserSession = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Change the current user's password and refresh the access cookie."""
    if not await verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    if body.current_password == body.new_password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="New password must be different from the current password",
        )

    current_user.password_hash = await hash_password(body.new_password)
    revoked_ids = await revoke_user_sessions(current_user.id, db, except_session_id=session.id)
    session.last_used_at = datetime.now(UTC)
    await db.commit()
    drop_session_streams(revoked_ids)
    _set_access_cookie(response, create_access_token(current_user.id, current_user.email, session.id))


@router.patch("/preferences", response_model=UserResponse)
async def update_preferences(
    body: PreferencesUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Update stored user preferences after validating dashboard access."""
    validated_preferences = body.model_dump(exclude_unset=True)
    if body.home_dashboard_id is not None:
        normalized_home_dashboard_ids = await _normalize_accessible_dashboard_ids(
            [body.home_dashboard_id],
            current_user,
            db,
        )
        validated_preferences["home_dashboard_id"] = normalized_home_dashboard_ids[0]
    if "favorite_dashboard_ids" in body.model_fields_set:
        if body.favorite_dashboard_ids is None:
            validated_preferences["favorite_dashboard_ids"] = []
        else:
            validated_preferences["favorite_dashboard_ids"] = await _normalize_accessible_dashboard_ids(
                body.favorite_dashboard_ids,
                current_user,
                db,
            )

    # Merge update into existing preferences so other keys are preserved.
    # exclude_unset=True ensures fields not sent in the request body don't overwrite existing prefs.
    current_prefs: dict = current_user.preferences or {}
    current_user.preferences = {**current_prefs, **validated_preferences}
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)
