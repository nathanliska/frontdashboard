from enum import StrEnum

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    development = "development"
    production = "production"
    test = "test"


# Placeholder secrets shipped in example env files — never valid in production.
_INSECURE_SECRETS = frozenset({"changeme", "change_me", "CHANGE_ME_TO_A_LONG_RANDOM_SECRET"})


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    # Comma-separated origins, e.g. "http://localhost:5173,http://localhost:3000"
    cors_origins: str = "http://localhost:5173"
    environment: Environment
    log_level: str = "INFO"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    email_verification_expire_hours: int = 1
    password_reset_expire_hours: int = 1
    # Invite links are handed out person-to-person, so they need a longer life than an
    # emailed token — but they are bearer credentials, so not an unbounded one.
    dashboard_invite_expire_hours: int = 168
    # Peak concurrent Argon2 hash/verify operations (each ~64 MiB). Bounds memory under an
    # auth burst; excess auth requests queue while the event loop stays responsive (finding #13).
    argon2_max_concurrency: int = 4
    frontend_base_url: str = "http://localhost:5173"
    resend_api_key: str | None = None
    email_from: str = "FrontDashboard <noreply@frontdashboard.local>"
    # Where development parks outgoing mail when there is no API key (finding #42). Relative to the
    # backend working directory, which is bind-mounted in dev, so the files land on the host.
    dev_mail_dir: str = ".dev-mail"
    # Background retention sweep of expired auth rows (finding #38).
    reaper_enabled: bool = True
    reaper_interval_hours: int = 6
    # How long activity and notification history is kept (finding #38). These are the only two
    # tables that grow with usage rather than with the number of users, so without a horizon they
    # grow forever. 90 days is well past the point anyone scrolls back to.
    history_retention_days: int = 90
    # Connection pool bounds (finding #37). Postgres costs roughly 5-10 MiB per backend
    # connection, so an unbounded pool turns a request burst into database memory pressure.
    # size + overflow is the ceiling on concurrent connections from one worker.
    db_pool_size: int = 5
    db_max_overflow: int = 5
    # How long a request waits for a free connection before failing instead of piling up.
    db_pool_timeout_seconds: int = 10
    # Recycle below any upstream idle-connection reaper so the pool never hands out a
    # server-side-closed socket.
    db_pool_recycle_seconds: int = 1800
    # Server-side ceiling on a single statement. A runaway query otherwise holds its connection
    # until the client gives up, which at this pool size is most of the pool.
    db_statement_timeout_seconds: int = 15
    # Bounded readiness probe — a hung database must fail the check, not hang it.
    health_ready_timeout_seconds: float = 3.0

    @field_validator("frontend_base_url", mode="before")
    @classmethod
    def validate_frontend_base_url(cls, v: object) -> str:
        url = str(v).strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise ValueError("frontend_base_url must start with http:// or https://")
        return url

    @model_validator(mode="after")
    def _validate_production_security(self) -> "Settings":
        if self.environment is not Environment.production:
            return self
        errors: list[str] = []
        if len(self.secret_key) < 32 or self.secret_key in _INSECURE_SECRETS:
            errors.append("secret_key must be at least 32 characters and not a placeholder")
        if not self.resend_api_key:
            errors.append("resend_api_key is required in production (email verification is mandatory)")
        if "@frontdashboard.local" in self.email_from.lower():
            errors.append("email_from must use a deliverable domain in production")
        if errors:
            raise ValueError("Invalid production configuration: " + "; ".join(errors))
        return self

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    model_config = SettingsConfigDict(env_file=["../.env", ".env"], env_file_encoding="utf-8", extra="ignore")


settings = Settings()
