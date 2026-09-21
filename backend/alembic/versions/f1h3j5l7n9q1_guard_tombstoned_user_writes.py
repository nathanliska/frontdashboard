"""guard tombstoned user writes

Revision ID: f1h3j5l7n9q1
Revises: e9g1i3k5m7o9
Create Date: 2026-09-20
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "f1h3j5l7n9q1"
down_revision: str | Sequence[str] | None = "e9g1i3k5m7o9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Returning OLD rather than NULL: NULL skips the row, and an ORM flush that matches 0 rows raises
# StaleDataError, turning a race that should be a no-op into a 500. OLD writes the row back
# unchanged, so the caller sees the one row it expected and the tombstone survives.
CREATE_FUNCTION = """
CREATE OR REPLACE FUNCTION users_keep_tombstone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RETURN OLD;
END;
$$;
"""

# WHEN, so the function is only reached for a row that is already a tombstone. The deletion's own
# write turns `deleted_at` on in the same statement, and its OLD is still live, so it passes.
CREATE_TRIGGER = """
CREATE TRIGGER users_keep_tombstone
BEFORE UPDATE ON users
FOR EACH ROW
WHEN (OLD.deleted_at IS NOT NULL)
EXECUTE FUNCTION users_keep_tombstone();
"""


def upgrade() -> None:
    op.execute(CREATE_FUNCTION)
    op.execute(CREATE_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS users_keep_tombstone ON users;")
    op.execute("DROP FUNCTION IF EXISTS users_keep_tombstone();")
