"""drop legacy group_id from activity events

Revision ID: u4w6y8a0c2e4
Revises: t2v4x6z8b0d2
Create Date: 2026-04-09
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "u4w6y8a0c2e4"
down_revision: str | Sequence[str] | None = "t2v4x6z8b0d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM activity_events WHERE group_id IS NOT NULL")
    op.drop_index("ix_activity_events_group", table_name="activity_events")
    op.drop_column("activity_events", "group_id")


def downgrade() -> None:
    raise RuntimeError("Dropping activity_events.group_id is intentionally irreversible")
