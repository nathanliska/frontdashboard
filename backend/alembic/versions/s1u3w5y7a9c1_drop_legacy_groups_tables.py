"""drop legacy groups, memberships, and invites tables

Revision ID: s1u3w5y7a9c1
Revises: r8t1v3x5z7b9
Create Date: 2026-04-08
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "s1u3w5y7a9c1"
down_revision: str | Sequence[str] | None = "r8t1v3x5z7b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM resource_shares WHERE principal_type = 'group'")
    op.execute("DROP TABLE IF EXISTS invites")
    op.execute("DROP TABLE IF EXISTS group_members")
    op.execute("DROP TABLE IF EXISTS groups")
    op.execute("DROP TYPE IF EXISTS group_role")


def downgrade() -> None:
    raise RuntimeError("Dropping the legacy groups tables is intentionally irreversible")
