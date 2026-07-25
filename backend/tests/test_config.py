from typing import Any

import pytest
from pydantic import ValidationError

from app.config import Settings

_BASE: dict[str, Any] = {
    "_env_file": None,
    "database_url": "postgresql+asyncpg://u:p@localhost/db",
    "secret_key": "x" * 40,
    "environment": "development",
}


def _make(**overrides: Any) -> Settings:
    return Settings(**{**_BASE, **overrides})


def test_invalid_environment_rejected() -> None:
    with pytest.raises(ValidationError):
        _make(environment="prod")


def test_development_skips_production_checks() -> None:
    # weak secret + no email config is fine outside production
    _make(environment="development", secret_key="short", resend_api_key=None)


def test_production_requires_strong_secret_and_email() -> None:
    with pytest.raises(ValidationError):
        _make(environment="production", secret_key="short")


def test_production_requires_resend_key() -> None:
    with pytest.raises(ValidationError):
        _make(
            environment="production",
            resend_api_key=None,
            email_from="FrontDashboard <noreply@example.com>",
        )


def test_production_rejects_default_email_from() -> None:
    with pytest.raises(ValidationError):
        _make(
            environment="production",
            resend_api_key="re_test",
            email_from="FrontDashboard <noreply@frontdashboard.local>",
        )


def test_valid_production_config_constructs() -> None:
    settings = _make(
        environment="production",
        secret_key="s" * 40,
        resend_api_key="re_test",
        email_from="FrontDashboard <noreply@example.com>",
    )
    assert settings.environment.value == "production"


def test_environment_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    # `_env_file=None` only ignores .env — pydantic-settings still reads the process
    # environment, and CI exports ENVIRONMENT for the app's own sake. Clear it here or this
    # test silently asserts nothing locally and fails on the runner.
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,  # ty: ignore[unknown-argument]  # pydantic-settings runtime option
            database_url="postgresql+asyncpg://u:p@localhost/db",
            secret_key="x" * 40,
        )
