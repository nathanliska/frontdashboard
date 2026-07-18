"""case-insensitive email uniqueness

Revision ID: c7e0f2a4b6d8
Revises: b5d8f0a2c4e6
Create Date: 2026-07-17
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e0f2a4b6d8"
down_revision: str | Sequence[str] | None = "b5d8f0a2c4e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    dupes = bind.execute(
        sa.text(
            "SELECT lower(email) AS k, count(*) AS n "
            "FROM users GROUP BY lower(email) HAVING count(*) > 1"
        )
    ).fetchall()
    if dupes:
        keys = ", ".join(row.k for row in dupes)
        raise RuntimeError(
            "Cannot enforce case-insensitive email uniqueness: accounts differ only by case "
            f"({keys}). Resolve these manually before migrating."
        )

    bind.execute(sa.text("UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email))"))
    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.create_index("uq_users_email_lower", "users", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index("uq_users_email_lower", table_name="users")
    op.create_unique_constraint("uq_users_email", "users", ["email"])
