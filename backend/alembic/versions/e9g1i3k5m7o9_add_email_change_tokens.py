"""add email change tokens

Revision ID: e9g1i3k5m7o9
Revises: c7e1a9b3d5f8
Create Date: 2026-09-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e9g1i3k5m7o9"
down_revision: str | Sequence[str] | None = "c7e1a9b3d5f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "email_change_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("new_email", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("token_hash", name="uq_email_change_tokens_token_hash"),
    )
    op.create_index("ix_email_change_tokens_user_active", "email_change_tokens", ["user_id", "used_at", "expires_at"])


def downgrade() -> None:
    op.drop_index("ix_email_change_tokens_user_active", table_name="email_change_tokens")
    op.drop_table("email_change_tokens")
