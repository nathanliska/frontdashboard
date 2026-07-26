import asyncio
from logging.config import fileConfig

from sqlalchemy import pool, text
from sqlalchemy.ext.asyncio import create_async_engine

import app.models.activity  # noqa: F401
import app.models.calendar  # noqa: F401
import app.models.dashboard  # noqa: F401
import app.models.dashboard_invite  # noqa: F401
import app.models.email_verification_token  # noqa: F401
import app.models.list  # noqa: F401
import app.models.notification  # noqa: F401
import app.models.password_reset_token  # noqa: F401
import app.models.refresh_token  # noqa: F401
import app.models.session  # noqa: F401
import app.models.share  # noqa: F401
import app.models.user  # noqa: F401
from alembic import context
from app.config import settings

# Import all models so their metadata is registered for autogenerate
from app.models import Base  # noqa: F401

config = context.config
if config.config_file_name is not None:
    # `disable_existing_loggers` defaults to True, which would switch off every logger not named in
    # alembic.ini — including the whole "app" tree. That is invisible when migrations run as their
    # own process (the deployed CMD), but the test suite upgrades in-process, so the default left
    # application logging dead for the rest of the run and quietly emptied any log assertion.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def database_url() -> str:
    """Prefer an explicitly supplied URL for programmatic migration runs."""
    configured_url = config.attributes.get("database_url")
    return str(configured_url) if configured_url is not None else settings.database_url


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


# Arbitrary but stable: identifies "FrontDashboard schema migration" across every process that
# might run one. Session-scoped (not transaction-scoped) so it spans everything a migration run
# does, and it releases on disconnect even if the process dies mid-wait.
_MIGRATION_LOCK_KEY = 0x66D0_DA5B


def do_run_migrations(connection) -> None:  # type: ignore[type-arg]
    # Serialize concurrent upgrade runs (finding #33): every API container executes
    # `alembic upgrade head` before serving, so a restart mid-deploy — or a second container
    # coming up during one — used to race the same DDL against itself. With the lock, the loser
    # waits, then finds the schema already at head and applies nothing.
    connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _MIGRATION_LOCK_KEY})
    # The execute above autobegins a transaction; end it before alembic manages its own, or the
    # migration work lands inside a transaction nothing ever commits. The lock is session-scoped,
    # so it survives this commit.
    connection.commit()
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    engine = create_async_engine(database_url(), poolclass=pool.NullPool)
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
        # The lock is session-scoped; the connection close below releases it. Explicit unlock
        # anyway, so a future refactor that pools this connection doesn't silently keep it.
        await connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": _MIGRATION_LOCK_KEY})
    await engine.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
