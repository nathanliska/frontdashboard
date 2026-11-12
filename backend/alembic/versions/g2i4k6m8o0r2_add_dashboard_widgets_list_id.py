"""add dashboard_widgets.list_id

Revision ID: g2i4k6m8o0r2
Revises: f1h3j5l7n9q1
Create Date: 2026-11-12
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "g2i4k6m8o0r2"
down_revision: str | Sequence[str] | None = "f1h3j5l7n9q1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Only where the list is live: `resource_id` never had a foreign key, so a row naming a list that
# is gone or trashed keeps its old columns and a NULL here. A trashed list has no widgets, and one
# keyed to it would vanish with the purge while its layout entry stayed.
BACKFILL = """
UPDATE dashboard_widgets AS w
SET list_id = w.resource_id
WHERE w.resource_type = 'list'
  AND EXISTS (SELECT 1 FROM lists AS l WHERE l.id = w.resource_id AND l.deleted_at IS NULL);
"""


def upgrade() -> None:
    op.add_column("dashboard_widgets", sa.Column("list_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.execute(BACKFILL)
    op.create_foreign_key(
        "fk_dashboard_widgets_list_id",
        "dashboard_widgets",
        "lists",
        ["list_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_dashboard_widgets_list_id", "dashboard_widgets", ["list_id"])


def downgrade() -> None:
    op.drop_index("ix_dashboard_widgets_list_id", table_name="dashboard_widgets")
    op.drop_constraint("fk_dashboard_widgets_list_id", "dashboard_widgets", type_="foreignkey")
    op.drop_column("dashboard_widgets", "list_id")
