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
    email_verification_expire_hours: int = 24
    frontend_base_url: str = "http://localhost:5173"
    resend_api_key: str | None = None
    email_from: str = "FrontDashboard <noreply@frontdashboard.local>"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    model_config = SettingsConfigDict(env_file=["../.env", ".env"], env_file_encoding="utf-8", extra="ignore")


settings = Settings()  # ty: ignore[missing-argument]
