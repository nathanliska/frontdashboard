from alembic.config import Config

from alembic import command


def test_database_is_at_head_and_matches_models(alembic_config: Config) -> None:
    command.current(alembic_config, check_heads=True)
    command.check(alembic_config)
