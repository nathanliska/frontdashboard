"""calendar event participants

Revision ID: 9667794850f6
Revises: e0d00a65b16f
Create Date: 2026-08-08

One row per member attached to an event. Cascades with its event; the `users` FK deliberately
does not cascade — the retention sweep treats a participant row as a sign of a live account,
and a purge that missed it must fail loudly rather than orphan the row.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9667794850f6"
down_revision: str | Sequence[str] | None = "e0d00a65b16f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the participants table."""
    op.create_table(
        "calendar_event_participants",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "calendar_event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("calendar_events.id", ondelete="CASCADE", name="fk_calendar_event_participants_event"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_calendar_event_participants_user"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("calendar_event_id", "user_id", name="uq_calendar_event_participants_member"),
    )
    op.create_index("ix_calendar_event_participants_event", "calendar_event_participants", ["calendar_event_id"])


def downgrade() -> None:
    """Drop the participants table."""
    op.drop_index("ix_calendar_event_participants_event", table_name="calendar_event_participants")
    op.drop_table("calendar_event_participants")
