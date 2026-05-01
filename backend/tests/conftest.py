import asyncio
from collections.abc import AsyncGenerator
from urllib.parse import parse_qs, urlparse

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from testcontainers.postgres import PostgresContainer

from app.database import get_db
from app.limiter import limiter
from app.main import app

_container: PostgresContainer | None = None
_test_engine = None


def pytest_configure(config: pytest.Config) -> None:
    global _container, _test_engine

    _container = PostgresContainer("postgres:16-alpine")
    _container.start()

    async_url = _container.get_connection_url().replace("+psycopg2", "+asyncpg")
    # NullPool avoids cross-event-loop connection reuse between asyncio.run() calls
    _test_engine = create_async_engine(async_url, echo=False, poolclass=NullPool)

    import app.models.activity  # noqa: F401
    import app.models.calendar  # noqa: F401
    import app.models.dashboard  # noqa: F401
    import app.models.email_verification_token  # noqa: F401
    import app.models.list  # noqa: F401
    import app.models.notification  # noqa: F401
    import app.models.password_reset_token  # noqa: F401
    import app.models.refresh_token  # noqa: F401
    import app.models.share  # noqa: F401
    import app.models.user  # noqa: F401
    from app.models.base import Base

    async def _create_tables() -> None:
        async with _test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create_tables())


def pytest_unconfigure(config: pytest.Config) -> None:
    global _container, _test_engine
    if _test_engine:
        asyncio.run(_test_engine.dispose())
        _test_engine = None
    if _container:
        _container.stop()
        _container = None


@pytest.fixture(autouse=True)
async def reset_test_state(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[None, None]:
    """Reset non-database global state after each test."""
    app.state.email_verification_tokens = {}
    app.state.password_reset_tokens = {}

    async def _capture_verification_email(email: str, verification_url: str) -> None:
        query = parse_qs(urlparse(verification_url).query)
        app.state.email_verification_tokens[email] = query["token"][0]

    async def _capture_password_reset_email(email: str, reset_url: str) -> None:
        query = parse_qs(urlparse(reset_url).query)
        app.state.password_reset_tokens[email] = query["token"][0]

    monkeypatch.setattr("app.routers.auth.send_verification_email", _capture_verification_email)
    monkeypatch.setattr("app.routers.auth.send_password_reset_email", _capture_password_reset_email)
    yield
    limiter._storage.reset()


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    assert _test_engine is not None
    async with _test_engine.connect() as conn:
        transaction = await conn.begin()
        session = AsyncSession(
            bind=conn,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        try:
            yield session
        finally:
            await session.close()
            if transaction.is_active:
                await transaction.rollback()


@pytest.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
async def db_client(client: AsyncClient) -> AsyncGenerator[AsyncClient, None]:
    yield client


@pytest.fixture
async def auth_client(db_client: AsyncClient) -> AsyncGenerator[AsyncClient, None]:
    """Client pre-authenticated as a throwaway test user."""
    resp = await db_client.post(
        "/api/auth/register",
        json={
            "email": "testuser@example.com",
            "password": "testpassword123",
            "display_name": "Test User",
        },
    )
    assert resp.status_code == 201
    token = app.state.email_verification_tokens["testuser@example.com"]
    verify_resp = await db_client.post("/api/auth/verify-email", json={"token": token})
    assert verify_resp.status_code == 200
    yield db_client
