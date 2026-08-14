"""index list_items.created_by for the per-creator quota

Revision ID: a3c5e7g9i1k3
Revises: 9667794850f6
Create Date: 2026-08-12

The quota counts every row a creator owns, trashed included, so it filters on `created_by` alone.
Neither existing index leads with that column, which would leave a sequential scan on the path of
every item create. Built CONCURRENTLY: the table is the largest one here and an ACCESS EXCLUSIVE
lock would stall writes for its duration.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a3c5e7g9i1k3"
down_revision: str | Sequence[str] | None = "9667794850f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.create_index(
            "ix_list_items_created_by",
            "list_items",
            ["created_by"],
            postgresql_concurrently=True,
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(
            "ix_list_items_created_by",
            table_name="list_items",
            postgresql_concurrently=True,
        )
