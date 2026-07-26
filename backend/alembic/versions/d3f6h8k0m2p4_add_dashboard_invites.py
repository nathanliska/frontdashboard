"""add dashboard invites

Revision ID: d3f6h8k0m2p4
Revises: c7e0f2a4b6d8
Create Date: 2026-07-25
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d3f6h8k0m2p4"
down_revision: str | Sequence[str] | None = "c7e0f2a4b6d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dashboard_invites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("dashboard_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code_hash", sa.String(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("redeemed_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("code_hash", name="uq_dashboard_invites_code_hash"),
    )
    op.create_index(
        "ix_dashboard_invites_dashboard_active",
        "dashboard_invites",
        ["dashboard_id", "used_at", "revoked_at", "expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_dashboard_invites_dashboard_active", table_name="dashboard_invites")
    op.drop_table("dashboard_invites")
