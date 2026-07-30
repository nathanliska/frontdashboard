import uuid
from datetime import datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.schemas.common import PatchModel


def _normalize_email(v: str) -> str:
    return v.strip().lower()


NormalizedEmail = Annotated[EmailStr, AfterValidator(_normalize_email)]

DISPLAY_NAME_MAX_LENGTH = 100


def _normalize_display_name(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("Display name cannot be empty")
    if len(v) > DISPLAY_NAME_MAX_LENGTH:
        raise ValueError(f"Display name must be at most {DISPLAY_NAME_MAX_LENGTH} characters")
    return v


DisplayName = Annotated[str, AfterValidator(_normalize_display_name)]


class RegisterRequest(BaseModel):
    email: NormalizedEmail
    password: str = Field(min_length=8, max_length=128)
    display_name: DisplayName


class LoginRequest(BaseModel):
    email: NormalizedEmail
    password: str


class ResendVerificationRequest(BaseModel):
    email: NormalizedEmail


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=1)


class PasswordResetRequest(BaseModel):
    email: NormalizedEmail


class PasswordResetTokenCheck(BaseModel):
    token: str = Field(min_length=1)


class PasswordResetTokenStatus(BaseModel):
    valid: bool


class PasswordResetConfirmRequest(BaseModel):
    token: str = Field(min_length=1)
    new_password: str = Field(min_length=8, max_length=128)


class RegistrationResponse(BaseModel):
    email: str


class UserPreferences(BaseModel):
    """Typed subset of the free-form User.preferences JSONB column.

    Unknown keys stored in the DB are silently ignored; missing keys default
    to None. Add new preference fields here as the app grows — the JSONB
    column is the source of truth, this model just validates the slice we care
    about at the application level.
    """

    home_dashboard_id: str | None = None
    favorite_dashboard_ids: list[str] = Field(default_factory=list)


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    preferences: UserPreferences = UserPreferences()
    email_verified_at: datetime | None = None

    model_config = {"from_attributes": True}

    @field_validator("preferences", mode="before")
    @classmethod
    def _parse_preferences(cls, v: object) -> UserPreferences:
        # The ORM gives us a raw dict from JSONB; parse it into the typed model.
        if isinstance(v, dict):
            return UserPreferences.model_validate(v)
        if v is None:
            return UserPreferences()
        if not isinstance(v, UserPreferences):
            raise ValueError(f"unexpected preferences type: {type(v)}")
        return v


class PreferencesUpdate(PatchModel):
    home_dashboard_id: str | None = None
    favorite_dashboard_ids: list[str] | None = None

    model_config = ConfigDict(extra="forbid")


class ProfileUpdate(PatchModel):
    display_name: str | None = None

    model_config = ConfigDict(extra="forbid")


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)
