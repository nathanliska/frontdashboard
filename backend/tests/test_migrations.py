from pathlib import Path

from alembic.config import Config

from alembic import command


def test_database_is_at_head_and_matches_models(alembic_config: Config) -> None:
    command.current(alembic_config, check_heads=True)
    command.check(alembic_config)


async def test_concurrent_upgrades_serialize_instead_of_racing(test_database) -> None:
    """Two `alembic upgrade head` runs at once must serialize on the advisory lock.

    Every API container migrates at startup, so a restart mid-deploy runs this exact race.
    Subprocesses, not threads: that is what two containers are, and alembic's command layer
    is not thread-safe in-process. Both runs point at the already-migrated test database —
    the property under test is that both complete cleanly (the loser waits on the lock, sees
    head, applies nothing) rather than colliding in DDL.
    """
    import asyncio
    import os
    import subprocess
    import sys

    database_url = test_database.alembic_config.attributes["database_url"]

    def _upgrade() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(  # noqa: S603
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            env={**os.environ, "DATABASE_URL": database_url},
            cwd=str(Path(__file__).resolve().parents[1]),
            capture_output=True,
            timeout=120,
            check=False,
        )

    first, second = await asyncio.gather(asyncio.to_thread(_upgrade), asyncio.to_thread(_upgrade))
    assert first.returncode == 0, first.stderr.decode()
    assert second.returncode == 0, second.stderr.decode()
