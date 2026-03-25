import asyncio
from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from testcontainers.postgres import PostgresContainer

from app.database import get_db
from app.limiter import limiter
from app.main import app

_container: PostgresContainer | None = None
_test_engine = None
_TestSession: async_sessionmaker | None = None


def pytest_configure(config: pytest.Config) -> None:
    global _container, _test_engine, _TestSession

    _container = PostgresContainer("postgres:16-alpine")
    _container.start()

    async_url = _container.get_connection_url().replace("+psycopg2", "+asyncpg")
    # NullPool avoids cross-event-loop connection reuse between asyncio.run() calls
    _test_engine = create_async_engine(async_url, echo=False, poolclass=NullPool)
    _TestSession = async_sessionmaker(_test_engine, expire_on_commit=False)

    import app.models.dashboard  # noqa: F401
    import app.models.group  # noqa: F401
    import app.models.invite  # noqa: F401
    import app.models.refresh_token  # noqa: F401
    import app.models.user  # noqa: F401
    from app.models.base import Base

    async def _create_tables() -> None:
        async with _test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create_tables())


def pytest_unconfigure(config: pytest.Config) -> None:
    global _container, _test_engine, _TestSession
    if _test_engine:
        asyncio.run(_test_engine.dispose())
        _test_engine = None
        _TestSession = None
    if _container:
        _container.stop()
        _container = None


@pytest.fixture(autouse=True)
async def clean_tables() -> AsyncGenerator[None, None]:
    """Truncate all tables and reset rate limits after each test."""
    yield
    from app.models.base import Base

    table_names = ", ".join(t.name for t in Base.metadata.sorted_tables)
    async with _test_engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE TABLE {table_names} CASCADE"))
    limiter._storage.reset()


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    assert _TestSession is not None
    async with _TestSession() as session:
        yield session


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Client with get_db overridden to use the test session."""

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


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
    yield db_client
