import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
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
    fileConfig(config.config_file_name)

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


def do_run_migrations(connection) -> None:  # type: ignore[type-arg]
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
    await engine.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
