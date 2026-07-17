"""add sessions, make refresh tokens session-scoped

Revision ID: b5d8f0a2c4e6
Revises: a3f7c2e9d1b4
Create Date: 2026-07-16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b5d8f0a2c4e6"
down_revision: str | Sequence[str] | None = "a3f7c2e9d1b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("device_name", sa.String(), nullable=True),
        sa.Column("ip_hash", sa.String(), nullable=True),
        sa.Column("user_agent_hash", sa.String(), nullable=True),
    )
    op.create_index("ix_sessions_user_live", "sessions", ["user_id", "revoked_at"])

    # The index is on (user_id, revoked, expires_at) — it must go before `revoked` does.
    op.drop_index("ix_refresh_tokens_user_active", table_name="refresh_tokens")

    # Every existing refresh token predates sessions and cannot be pointed at one:
    # no backfill, everyone signs in once more. Delete rather than revoke — a
    # revoked row with a NULL session_id could not satisfy the NOT NULL below.
    op.execute("DELETE FROM refresh_tokens")

    op.add_column(
        "refresh_tokens",
        sa.Column("session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
    )
    op.add_column("refresh_tokens", sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_column("refresh_tokens", "revoked")
    op.drop_column("refresh_tokens", "device_name")
    op.drop_column("refresh_tokens", "ip_hash")
    op.drop_column("refresh_tokens", "user_agent_hash")
    op.drop_column("refresh_tokens", "last_used_at")

    # users.id FK had no ondelete; recreate it with CASCADE so deleting a user
    # cleans up its tokens (the concurrency fixture depends on this).
    op.drop_constraint("refresh_tokens_user_id_fkey", "refresh_tokens", type_="foreignkey")
    op.create_foreign_key(
        "refresh_tokens_user_id_fkey", "refresh_tokens", "users", ["user_id"], ["id"], ondelete="CASCADE"
    )

    op.create_index("ix_refresh_tokens_user_active", "refresh_tokens", ["user_id", "revoked_at", "expires_at"])


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_user_active", table_name="refresh_tokens")
    op.drop_constraint("refresh_tokens_user_id_fkey", "refresh_tokens", type_="foreignkey")
    op.create_foreign_key("refresh_tokens_user_id_fkey", "refresh_tokens", "users", ["user_id"], ["id"])
    op.execute("DELETE FROM refresh_tokens")
    op.add_column("refresh_tokens", sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("refresh_tokens", sa.Column("user_agent_hash", sa.String(), nullable=True))
    op.add_column("refresh_tokens", sa.Column("ip_hash", sa.String(), nullable=True))
    op.add_column("refresh_tokens", sa.Column("device_name", sa.String(), nullable=True))
    op.add_column("refresh_tokens", sa.Column("revoked", sa.Boolean(), nullable=False, server_default="false"))
    op.drop_column("refresh_tokens", "revoked_at")
    op.drop_column("refresh_tokens", "session_id")
    op.create_index("ix_refresh_tokens_user_active", "refresh_tokens", ["user_id", "revoked", "expires_at"])
    op.drop_index("ix_sessions_user_live", table_name="sessions")
    op.drop_table("sessions")
