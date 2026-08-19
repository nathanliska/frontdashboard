import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.config import Settings
from tests.conftest import POSTGRES_IMAGE_DEFAULT

# Every stack that runs the shared store. A new one belongs here deliberately, not by discovery.
_STORE_COMPOSE_FILES = (
    "docker-compose.prod.yml",
    "docker-compose.smoke.yml",
    "docker-compose.verify.yml",
    "docker-compose.yml",
)

_BASE: dict[str, Any] = {
    "_env_file": None,
    "database_url": "postgresql+asyncpg://u:p@localhost/db",
    "environment": "development",
}


def _make(**overrides: Any) -> Settings:
    return Settings(**{**_BASE, **overrides})


def test_invalid_environment_rejected() -> None:
    with pytest.raises(ValidationError):
        _make(environment="prod")


def test_development_skips_production_checks() -> None:
    # No email config is fine outside production.
    _make(environment="development", resend_api_key=None)


def test_the_session_windows_are_ordered() -> None:
    """Idle must be the tighter of the two clocks.

    Inverted, the absolute bound is unreachable and a session slides forever.
    """
    settings = _make()
    assert 0 < settings.session_idle_days <= settings.session_absolute_days


def test_production_requires_resend_key() -> None:
    with pytest.raises(ValidationError):
        _make(
            environment="production",
            resend_api_key=None,
            email_from="FrontDashboard <noreply@example.com>",
        )


def test_production_rejects_an_empty_redis_url() -> None:
    """An empty uri reads as `memory://` to slowapi, degrading to per-process limits.

    Silently: there is no unreachable store to detect, so neither the fallback warning nor any
    error would fire, and N replicas would each enforce the full limit on their own.
    """
    with pytest.raises(ValidationError):
        _make(
            environment="production",
            resend_api_key="re_test",
            email_from="FrontDashboard <noreply@example.com>",
            redis_url="",
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
            _env_file=None,  # pydantic-settings runtime option
            database_url="postgresql+asyncpg://u:p@localhost/db",
        )


def test_dev_compose_and_test_container_pin_the_same_postgres() -> None:
    """Drift here is invisible until a restore fails, so fail the build instead.

    A dump taken from one major version will not load into another, which makes an unnoticed
    dev/test/prod version split a backup you cannot actually restore.
    """
    compose = (Path(__file__).resolve().parents[2] / "docker-compose.yml").read_text()
    match = re.search(r"image:\s*\$\{POSTGRES_IMAGE:-([^}]+)\}", compose)
    assert match, "docker-compose.yml no longer parameterizes the db image via POSTGRES_IMAGE"
    assert match.group(1) == POSTGRES_IMAGE_DEFAULT


def test_every_compose_file_pins_the_same_shared_store() -> None:
    """Smoke and verify exist to prove prod works, which they cannot on a different engine.

    The image is named in every stack, so a swap is one hand edit per file and a miss is silent:
    the stack still boots, and only the environment that drifted tests something prod is not.
    """
    root = Path(__file__).resolve().parents[2]
    pins = {}
    for path in sorted(root.glob("docker-compose*.yml")):
        block = re.search(r"^  redis:\n(?:(?:    .*|\n)*)", path.read_text(), re.M)
        if block is None:
            continue
        image = re.search(r"^    image:\s*(\S+)", block.group(0), re.M)
        assert image, f"{path.name} declares a store service with no pinned image"
        pins[path.name] = image.group(1)

    # Asserted against the known set rather than a floor: a floor passes while some files drift,
    # and discovery alone would pass having found nothing if the service were ever renamed.
    assert set(pins) == set(_STORE_COMPOSE_FILES), f"compose files declaring a store changed: {sorted(pins)}"
    assert len(set(pins.values())) == 1, f"shared-store image drifted between compose files: {pins}"
