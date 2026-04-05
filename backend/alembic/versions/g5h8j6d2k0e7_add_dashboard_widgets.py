"""add_dashboard_widgets

Revision ID: g5h8j6d2k0e7
Revises: f4g7i5e1h9d6
Create Date: 2026-03-30 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "g5h8j6d2k0e7"
down_revision: str | None = "f4g7i5e1h9d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dashboard_widgets",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("dashboard_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("widget_type", sa.String(50), nullable=False),
        sa.Column("widget_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("resource_type", sa.String(50), nullable=True),
        sa.Column("resource_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["dashboard_id"], ["dashboards.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "ix_dashboard_widgets_dashboard_id",
        "dashboard_widgets",
        ["dashboard_id"],
    )
    # Migrate layout default from object to array
    op.alter_column("dashboards", "layout", server_default="[]")


def downgrade() -> None:
    op.alter_column("dashboards", "layout", server_default='{"rows": []}')
    op.drop_index("ix_dashboard_widgets_dashboard_id", table_name="dashboard_widgets")
    op.drop_table("dashboard_widgets")
