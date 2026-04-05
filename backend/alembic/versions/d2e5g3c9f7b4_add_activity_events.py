"""add_activity_events

Revision ID: d2e5g3c9f7b4
Revises: c1d4f2b8e6a3
Create Date: 2026-03-30 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d2e5g3c9f7b4"
down_revision: str | None = "c1d4f2b8e6a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Sequence for monotonically increasing SSE Last-Event-ID
    op.execute("CREATE SEQUENCE IF NOT EXISTS activity_events_event_id_seq")

    op.create_table(
        "activity_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "event_id",
            sa.BigInteger(),
            server_default=sa.text("nextval('activity_events_event_id_seq')"),
            nullable=False,
            unique=True,
        ),
        sa.Column("event_type", sa.String(50), nullable=False),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_display_name", sa.String(200), nullable=False),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("entity_version", sa.BigInteger(), server_default="1", nullable=False),
        sa.Column("payload", postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_activity_events_event_id", "activity_events", ["event_id"])
    op.create_index(
        "ix_activity_events_group", "activity_events", ["group_id", "created_at"]
    )
    op.create_index(
        "ix_activity_events_actor", "activity_events", ["actor_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_activity_events_actor", table_name="activity_events")
    op.drop_index("ix_activity_events_group", table_name="activity_events")
    op.drop_index("ix_activity_events_event_id", table_name="activity_events")
    op.drop_table("activity_events")
    op.execute("DROP SEQUENCE IF EXISTS activity_events_event_id_seq")
