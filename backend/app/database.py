from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_pre_ping=True,
    # Bounded so a burst can't open connections without limit — Postgres pays several MiB each, and
    # every replica gets its own pool, so N x (size + overflow) must fit under the server's
    # max_connections, shared with whatever else uses that instance. Past it: wait, then fail.
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout_seconds,
    pool_recycle=settings.db_pool_recycle_seconds,
    connect_args={
        # Server-enforced, so it also bounds a query that outlives the client's interest in it.
        # asyncpg applies these as session settings on connect.
        "server_settings": {
            "statement_timeout": str(settings.db_statement_timeout_seconds * 1000),
            "application_name": "frontdashboard",
        }
    },
)

async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session
