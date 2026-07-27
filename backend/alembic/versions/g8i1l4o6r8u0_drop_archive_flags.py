"""Drop the archive flags from dashboards and lists — trash is the only put-away state now.

Archive and trash were two overlapping "hide this" concepts with different promises, and the
pair was never explainable: trash is recoverable and eventually purges, archive was forever but
had no restore vocabulary of its own. Trash won because it can do both jobs safely.

**Existing archived rows are un-archived, not trashed.** Stamping `deleted_at` would start a
30-day purge clock on data whose owner explicitly chose to keep it — the opposite of what
archiving meant. So archived dashboards and lists simply become live again; anyone who actually
wanted them gone can move them to the trash, which is recoverable.

The dashboards listing index moves with the flag: `(user_id, archived, updated_at)` becomes
`(user_id, deleted_at, updated_at)`, matching the surviving filter.

Revision ID: g8i1l4o6r8u0
Revises: f7h0k3n5q7t9
Create Date: 2026-07-27
"""

import sqlalchemy as sa

from alembic import op

revision = "g8i1l4o6r8u0"
down_revision = "f7h0k3n5q7t9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("ix_dashboards_user_archived_updated", table_name="dashboards")
    op.create_index(
        "ix_dashboards_user_deleted_updated",
        "dashboards",
        ["user_id", "deleted_at", "updated_at"],
    )
    op.drop_column("dashboards", "archived")
    op.drop_column("lists", "archived")


def downgrade() -> None:
    # The flag comes back false everywhere: which rows *were* archived is not recoverable, and
    # inventing it would be worse than admitting it.
    op.add_column("lists", sa.Column("archived", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("dashboards", sa.Column("archived", sa.Boolean(), nullable=False, server_default="false"))
    op.drop_index("ix_dashboards_user_deleted_updated", table_name="dashboards")
    op.create_index(
        "ix_dashboards_user_archived_updated",
        "dashboards",
        ["user_id", "archived", "updated_at"],
    )
