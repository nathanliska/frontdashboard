"""dashboard_name_and_multi

Revision ID: h6i9k7e3l1f8
Revises: g5h8j6d2k0e7
Create Date: 2026-03-30 00:00:00.000000

Design change: multiple personal dashboards per user.
- Add `name` and `is_favorite` columns to dashboards
- Drop the partial unique index that enforced one-per-user
  (one-per-group index on group_id is kept — still one shared dashboard per group)
- Seed existing private dashboards with the default name

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "h6i9k7e3l1f8"
down_revision: str | None = "g5h8j6d2k0e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Drop both one-per-owner partial unique indexes (allow multiple dashboards per user/group)
    op.drop_index("uq_dashboards_user", table_name="dashboards")
    op.drop_index("uq_dashboards_group", table_name="dashboards")

    # Add name and is_favorite
    op.add_column("dashboards", sa.Column("name", sa.String(100), nullable=True))
    op.add_column(
        "dashboards",
        sa.Column("is_favorite", sa.Boolean(), nullable=False, server_default="false"),
    )

    # Back-fill names for existing rows
    op.execute("UPDATE dashboards SET name = 'My Dashboard' WHERE user_id IS NOT NULL")
    op.execute("UPDATE dashboards SET name = 'Group Dashboard' WHERE group_id IS NOT NULL")

    # Make name non-nullable now that all rows have a value
    op.alter_column("dashboards", "name", nullable=False)


def downgrade() -> None:
    op.drop_column("dashboards", "is_favorite")
    op.drop_column("dashboards", "name")
    op.create_index(
        "uq_dashboards_group",
        "dashboards",
        ["group_id"],
        unique=True,
        postgresql_where=sa.text("group_id IS NOT NULL"),
    )
    op.create_index(
        "uq_dashboards_user",
        "dashboards",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("user_id IS NOT NULL"),
    )
