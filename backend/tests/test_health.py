import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

import app.main as main_module
from app.config import settings
from app.main import app, lifespan


async def test_health(client: AsyncClient):
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


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
