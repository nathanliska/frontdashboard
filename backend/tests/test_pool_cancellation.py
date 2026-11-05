"""A database unit cancelled mid-query must leave the pool healthy for the next request."""

import anyio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from tests.conftest import _TestDatabase

_SLOW_QUERY = "SELECT pg_sleep(2)"


async def _slow_unit(factory: async_sessionmaker) -> None:
    async with factory() as db:
        await db.execute(text(_SLOW_QUERY))


async def _query_is_running(test_database: _TestDatabase) -> bool:
    probe = text("SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query = :q")
    for _ in range(50):
        async with test_database.engine.connect() as conn:
            if await conn.scalar(probe, {"q": _SLOW_QUERY}):
                return True
        await anyio.sleep(0.05)
    return False


async def test_a_unit_cancelled_mid_query_leaves_the_pool_healthy(test_database: _TestDatabase) -> None:
    """The SSE stream's checks are cancelled through sse-starlette's anyio scope when a client leaves.

    An anyio scope re-cancels every await until it exits, including the close of the connection the
    cancel interrupted; a plain `task.cancel()` is absorbed by the shield around that close and never
    reaches it. SQLAlchemy below 2.0.55 then checked the closed connection back in and handed it to
    the next request; the pin in pyproject.toml is what this test guards.
    """
    engine = create_async_engine(test_database.engine.url, pool_size=1, max_overflow=0)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with anyio.create_task_group() as tg:
            tg.start_soon(_slow_unit, factory)
            # Cancelled only once the query is on the server, or an early cancel leaves nothing to leak.
            assert await _query_is_running(test_database)
            tg.cancel_scope.cancel()

        # No pre-ping on this engine on purpose: the pool itself must not hold a dead connection.
        async with engine.connect() as conn:
            assert await conn.scalar(text("SELECT 1")) == 1
    finally:
        await engine.dispose()
