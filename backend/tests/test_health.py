import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

import app.main as main_module
import app.routers.health as health_module
from app.config import settings
from app.main import app, lifespan
from tests.conftest import _TestDatabase


async def test_health(client: AsyncClient):
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_liveness_does_not_touch_the_database(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def _explode() -> None:
        raise AssertionError("liveness must not reach the database")

    monkeypatch.setattr(health_module, "engine", SimpleNamespace(connect=_explode))

    # Liveness answers "should this process be replaced". Routing that through the dependency
    # that might be broken is exactly how a transient outage becomes a restart loop.
    response = await client.get("/api/health")
    assert response.status_code == 200


async def test_readiness_reports_ready_against_a_live_database(
    db_client: AsyncClient, test_database: _TestDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Readiness probes the real engine rather than the request-scoped session, which is what
    # makes it meaningful in production — so point it at the test database explicitly.
    monkeypatch.setattr(health_module, "engine", test_database.engine)

    response = await db_client.get("/api/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "database": True}


async def test_readiness_fails_when_the_database_is_unreachable(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def _refuse() -> None:
        raise OSError("connection refused")

    monkeypatch.setattr(health_module, "engine", SimpleNamespace(connect=_refuse))

    response = await client.get("/api/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "database": False}


async def test_readiness_is_bounded_when_the_database_hangs(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    class _HangingConnect:
        async def __aenter__(self) -> None:
            await asyncio.sleep(60)

        async def __aexit__(self, *_: object) -> None:
            return None

    monkeypatch.setattr(health_module, "engine", SimpleNamespace(connect=lambda: _HangingConnect()))
    monkeypatch.setattr(settings, "health_ready_timeout_seconds", 0.05)

    # A hung database is the failure this endpoint exists for; an unbounded probe would hang
    # with it and report nothing at all.
    response = await client.get("/api/health/ready")
    assert response.status_code == 503
    assert response.json()["database"] is False


async def test_lifespan_disposes_database_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    dispose = AsyncMock()
    monkeypatch.setattr(settings, "reaper_enabled", False)
    monkeypatch.setattr(main_module, "engine", SimpleNamespace(dispose=dispose))

    async with lifespan(app):
        pass

    dispose.assert_awaited_once()


async def test_lifespan_disposes_database_engine_when_reaper_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    dispose = AsyncMock()

    async def _failing_reaper() -> None:
        raise RuntimeError("reaper failed")

    monkeypatch.setattr(settings, "reaper_enabled", True)
    monkeypatch.setattr(main_module, "reaper_loop", _failing_reaper)
    monkeypatch.setattr(main_module, "engine", SimpleNamespace(dispose=dispose))

    with pytest.raises(RuntimeError, match="reaper failed"):
        async with lifespan(app):
            await asyncio.sleep(0)

    dispose.assert_awaited_once()
