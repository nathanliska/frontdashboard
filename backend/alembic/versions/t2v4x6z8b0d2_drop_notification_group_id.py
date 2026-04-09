"""drop legacy group_id from notifications

Revision ID: t2v4x6z8b0d2
Revises: s1u3w5y7a9c1
Create Date: 2026-04-09
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "t2v4x6z8b0d2"
down_revision: str | Sequence[str] | None = "s1u3w5y7a9c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("notifications", "group_id")


def downgrade() -> None:
    raise RuntimeError("Dropping notifications.group_id is intentionally irreversible")
