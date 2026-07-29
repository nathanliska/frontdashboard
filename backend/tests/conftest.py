import asyncio
import os
import uuid
from collections.abc import AsyncGenerator, Generator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from testcontainers.postgres import PostgresContainer

from alembic import command
from app.database import get_db
from app.limiter import limiter
from app.main import app
from app.models.user import User

_BACKEND_ROOT = Path(__file__).resolve().parents[1]

# Dev, CI and production must run the same PostgreSQL major version. pg_dump refuses to read a
# server newer than itself and a newer dump won't restore into an older server, so a mismatch stays
# invisible until the night a restore matters. docker-compose.yml reads the same variable, and
# test_config.py fails the build if the two defaults drift apart.
POSTGRES_IMAGE_DEFAULT = "postgres:17-alpine"
POSTGRES_IMAGE = os.getenv("POSTGRES_IMAGE", POSTGRES_IMAGE_DEFAULT)


@dataclass(frozen=True)
class _TestDatabase:
    engine: AsyncEngine
    alembic_config: Config


def _asyncpg_url(url: str) -> str:
    if url.startswith("postgresql+psycopg2://"):
        return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql+asyncpg://"):
        return url
    raise ValueError("TEST_DATABASE_URL must be a PostgreSQL URL")


def _assert_disposable_test_database(url: str) -> None:
    """Refuse a TEST_DATABASE_URL that doesn't look like a dedicated test database.

    The suite runs `alembic upgrade head` against this database, and the
    `concurrent_sessions` fixture really commits and deletes rows in it. Pointed at a
    development or production database — easy to do by leaving the variable exported in a
    shell — that is destructive and silent. A naming convention is a cheap, enforceable
    invariant; documentation alone is not.
    """
    name = (urlparse(url).path or "").lstrip("/").split("?", 1)[0]
    if not name:
        raise ValueError(f"TEST_DATABASE_URL has no database name: {url!r}")
    if not (name.endswith("_test") or name.endswith("-test") or name.startswith("test_")):
        raise ValueError(
            f"Refusing to run tests against database {name!r}: the suite applies migrations and "
            "deletes rows, so TEST_DATABASE_URL must name a dedicated test database "
            "(ending in '_test'/'-test' or starting with 'test_')."
        )


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Classify tests from their resolved fixture graph."""
    for item in items:
        fixture_names = getattr(item, "fixturenames", ())
        marker = pytest.mark.integration if "test_database" in fixture_names else pytest.mark.unit
        item.add_marker(marker)


@pytest.fixture(scope="session")
def test_database() -> Generator[_TestDatabase, None, None]:
    """Provide one migrated PostgreSQL database for integration tests.

    TEST_DATABASE_URL selects a dedicated existing test database. When it is
    absent, Testcontainers remains a convenient local fallback.
    """
    container: PostgresContainer | None = None
    configured_url = os.getenv("TEST_DATABASE_URL")
    if configured_url:
        _assert_disposable_test_database(configured_url)
        async_url = _asyncpg_url(configured_url)
    else:
        container = PostgresContainer(POSTGRES_IMAGE)
        try:
            container.start()
        except Exception as exc:
            raise RuntimeError(
                "Database tests need TEST_DATABASE_URL pointing to a dedicated PostgreSQL test database "
                "or a running Docker daemon for the Testcontainers fallback"
            ) from exc
        async_url = _asyncpg_url(container.get_connection_url())

    try:
        alembic_config = Config(str(_BACKEND_ROOT / "alembic.ini"))
        alembic_config.attributes["database_url"] = async_url
        command.upgrade(alembic_config, "head")

        # NullPool avoids cross-event-loop connection reuse between pytest-asyncio tests.
        engine = create_async_engine(async_url, echo=False, poolclass=NullPool)
        try:
            yield _TestDatabase(engine=engine, alembic_config=alembic_config)
        finally:
            asyncio.run(engine.dispose())
    finally:
        if container is not None:
            container.stop()


@pytest.fixture(scope="session")
def alembic_config(test_database: _TestDatabase) -> Config:
    return test_database.alembic_config


@pytest.fixture(autouse=True)
async def reset_test_state(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[None, None]:
    """Reset non-database global state after each test."""
    app.state.email_verification_tokens = {}
    app.state.password_reset_tokens = {}
    app.state.existing_account_emails = []

    async def _capture_verification_email(email: str, verification_url: str) -> None:
        query = parse_qs(urlparse(verification_url).query)
        app.state.email_verification_tokens[email] = query["token"][0]

    async def _capture_password_reset_email(email: str, reset_url: str) -> None:
        query = parse_qs(urlparse(reset_url).query)
        app.state.password_reset_tokens[email] = query["token"][0]

    async def _capture_existing_account_email(email: str) -> None:
        app.state.existing_account_emails.append(email)

    monkeypatch.setattr("app.routers.auth.send_verification_email", _capture_verification_email)
    monkeypatch.setattr("app.routers.auth.send_password_reset_email", _capture_password_reset_email)
    monkeypatch.setattr("app.routers.auth.send_existing_account_email", _capture_existing_account_email)
    yield
    limiter._storage.reset()


@pytest.fixture
async def db_session(test_database: _TestDatabase) -> AsyncGenerator[AsyncSession, None]:
    async with test_database.engine.connect() as conn:
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
async def concurrent_sessions(test_database: _TestDatabase) -> AsyncGenerator[tuple[AsyncSession, AsyncSession, uuid.UUID], None]:
    """Two independently-committing sessions plus a throwaway user.

    Everything else in this suite runs in a savepoint that is rolled back. These
    sessions really commit — which is the entire point, since the race depends on
    cross-transaction visibility — so they must clean up after themselves.

    Clean up by user, never TRUNCATE: savepoint-based tests hold open transactions
    on other connections, and a truncate would contend with them.
    """
    user_id = uuid.uuid4()

    async with AsyncSession(test_database.engine, expire_on_commit=False) as setup:
        setup.add(
            User(
                id=user_id,
                email=f"race-{user_id}@example.com",
                password_hash="x",
                display_name="Race",
                email_verified_at=datetime.now(UTC),
            )
        )
        await setup.commit()

    first = AsyncSession(test_database.engine, expire_on_commit=False)
    second = AsyncSession(test_database.engine, expire_on_commit=False)
    try:
        yield first, second, user_id
    finally:
        await first.close()
        await second.close()
        async with AsyncSession(test_database.engine, expire_on_commit=False) as cleanup:
            # sessions cascade from users.
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()


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
