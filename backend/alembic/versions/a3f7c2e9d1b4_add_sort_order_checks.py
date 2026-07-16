"""add nonnegative sort_order checks

Revision ID: a3f7c2e9d1b4
Revises: z9b2d4f6h8j0
Create Date: 2026-07-16
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "a3f7c2e9d1b4"
down_revision: str | Sequence[str] | None = "z9b2d4f6h8j0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint("ck_lists_sort_order_nonneg", "lists", "sort_order >= 0")
    op.create_check_constraint("ck_list_items_sort_order_nonneg", "list_items", "sort_order >= 0")


def downgrade() -> None:
    op.drop_constraint("ck_list_items_sort_order_nonneg", "list_items", type_="check")
    op.drop_constraint("ck_lists_sort_order_nonneg", "lists", type_="check")
