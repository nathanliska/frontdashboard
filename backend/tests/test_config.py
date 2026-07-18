import pytest
from pydantic import ValidationError

from app.config import Settings

_BASE = {
    "_env_file": None,
    "database_url": "postgresql+asyncpg://u:p@localhost/db",
    "secret_key": "x" * 40,
}


def _make(**overrides) -> Settings:
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
