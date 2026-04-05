import uuid

from pydantic import BaseModel, EmailStr, field_validator


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserPreferences(BaseModel):
    """Typed subset of the free-form User.preferences JSONB column.

    Unknown keys stored in the DB are silently ignored; missing keys default
    to None. Add new preference fields here as the app grows — the JSONB
    column is the source of truth, this model just validates the slice we care
    about at the application level.
    """

    home_dashboard_id: str | None = None


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    preferences: UserPreferences = UserPreferences()

    model_config = {"from_attributes": True}

    @field_validator("preferences", mode="before")
    @classmethod
    def _parse_preferences(cls, v: object) -> UserPreferences:
        # The ORM gives us a raw dict from JSONB; parse it into the typed model.
        if isinstance(v, dict):
            return UserPreferences.model_validate(v)
        if v is None:
            return UserPreferences()
        return v  # already a UserPreferences instance


class PreferencesUpdate(BaseModel):
    home_dashboard_id: str | None = None


class ProfileUpdate(BaseModel):
    email: EmailStr | None = None
    display_name: str | None = None


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str
