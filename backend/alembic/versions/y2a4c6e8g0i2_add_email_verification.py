"""add email verification

Revision ID: y2a4c6e8g0i2
Revises: v1x3z5b7d9f1
Create Date: 2026-04-30
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "y2a4c6e8g0i2"
down_revision: str | Sequence[str] | None = "v1x3z5b7d9f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "email_verification_tokens",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("token_hash", name="uq_email_verification_tokens_token_hash"),
    )
    op.create_index(
        "ix_email_verification_tokens_user_active",
        "email_verification_tokens",
        ["user_id", "used_at", "expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_email_verification_tokens_user_active", table_name="email_verification_tokens")
    op.drop_table("email_verification_tokens")
    op.drop_column("users", "email_verified_at")
