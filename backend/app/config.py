from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    # Comma-separated origins, e.g. "http://localhost:5173,http://localhost:3000"
    cors_origins: str = "http://localhost:5173"
    environment: str = "development"
    log_level: str = "INFO"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    email_verification_expire_hours: int = 1
    password_reset_expire_hours: int = 1
    frontend_base_url: str = "http://localhost:5173"
    resend_api_key: str | None = None
    email_from: str = "FrontDashboard <noreply@frontdashboard.local>"

    @field_validator("frontend_base_url", mode="before")
    @classmethod
    def validate_frontend_base_url(cls, v: object) -> str:
        url = str(v).strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise ValueError("frontend_base_url must start with http:// or https://")
        return url

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    model_config = SettingsConfigDict(env_file=["../.env", ".env"], env_file_encoding="utf-8", extra="ignore")


settings = Settings()  # ty: ignore[missing-argument]
