"""Drop list_items.deleted_at; items are deleted outright.

Revision ID: b4d6f8h0j2l4
Revises: a3c5e7g9i1k3
Create Date: 2026-08-14

Destructive and one-way: tombstoned items are deleted before the column goes, because dropping it
first would resurrect every one of them into its list. The downgrade restores the column and the
index shapes, not the rows (ADR-007).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b4d6f8h0j2l4"
down_revision: str | Sequence[str] | None = "a3c5e7g9i1k3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM list_items WHERE deleted_at IS NOT NULL")

    op.drop_index("ix_list_items_list_id", table_name="list_items")
    op.drop_index("ix_list_items_assigned_to", table_name="list_items")
    op.drop_column("list_items", "deleted_at")
    op.create_index("ix_list_items_list_id", "list_items", ["list_id", "sort_order"])
    op.create_index("ix_list_items_assigned_to", "list_items", ["assigned_to", "checked"])


def downgrade() -> None:
    op.drop_index("ix_list_items_list_id", table_name="list_items")
    op.drop_index("ix_list_items_assigned_to", table_name="list_items")
    op.add_column("list_items", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_list_items_list_id", "list_items", ["list_id", "sort_order", "deleted_at"])
    op.create_index("ix_list_items_assigned_to", "list_items", ["assigned_to", "checked", "deleted_at"])
