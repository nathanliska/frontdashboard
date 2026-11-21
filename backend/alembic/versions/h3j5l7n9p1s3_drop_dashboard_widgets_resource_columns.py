"""drop dashboard_widgets resource columns and widget_version

Revision ID: h3j5l7n9p1s3
Revises: g2i4k6m8o0r2
Create Date: 2026-11-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "h3j5l7n9p1s3"
down_revision: str | Sequence[str] | None = "g2i4k6m8o0r2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# `list_id` is the binding now, so the pair it replaced is restored from it. A widget whose old
# pair named a list that was already gone had no `list_id`, and comes back unbound.
RESTORE_PAIR = """
UPDATE dashboard_widgets
SET resource_type = 'list', resource_id = list_id
WHERE list_id IS NOT NULL;
"""


def upgrade() -> None:
    op.create_index(
        "uq_dashboard_widgets_list",
        "dashboard_widgets",
        ["dashboard_id", "list_id"],
        unique=True,
        postgresql_where=sa.text("list_id IS NOT NULL"),
    )
    op.drop_index("uq_dashboard_widgets_resource_binding", table_name="dashboard_widgets")
    op.drop_index("ix_dashboard_widgets_resource", table_name="dashboard_widgets")
    op.drop_constraint("ck_dashboard_widgets_resource_pair", "dashboard_widgets", type_="check")
    op.drop_column("dashboard_widgets", "resource_id")
    op.drop_column("dashboard_widgets", "resource_type")
    op.drop_column("dashboard_widgets", "widget_version")


def downgrade() -> None:
    op.add_column(
        "dashboard_widgets",
        sa.Column("widget_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("dashboard_widgets", sa.Column("resource_type", sa.String(length=50), nullable=True))
    op.add_column("dashboard_widgets", sa.Column("resource_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.execute(RESTORE_PAIR)
    op.create_check_constraint(
        "ck_dashboard_widgets_resource_pair",
        "dashboard_widgets",
        "(resource_type IS NULL) = (resource_id IS NULL)",
    )
    op.create_index(
        "ix_dashboard_widgets_resource",
        "dashboard_widgets",
        ["resource_type", "resource_id", "dashboard_id"],
    )
    op.create_index(
        "uq_dashboard_widgets_resource_binding",
        "dashboard_widgets",
        ["dashboard_id", "resource_type", "resource_id"],
        unique=True,
        postgresql_where=sa.text("resource_type IS NOT NULL AND resource_id IS NOT NULL"),
    )
    op.drop_index("uq_dashboard_widgets_list", table_name="dashboard_widgets")
