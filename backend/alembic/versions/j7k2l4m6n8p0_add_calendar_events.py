"""add_calendar_events

Revision ID: j7k2l4m6n8p0
Revises: h6i9k7e3l1f8
Create Date: 2026-04-02 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "j7k2l4m6n8p0"
down_revision: str | None = "h6i9k7e3l1f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


calendar_visibility = postgresql.ENUM(
    "private",
    "shared",
    name="calendar_visibility",
    create_type=False,
)


def upgrade() -> None:
    calendar_visibility.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "calendar_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("visibility", calendar_visibility, nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("timezone", sa.String(length=100), nullable=False),
        sa.Column("all_day", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("recurrence", postgresql.JSONB(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(visibility = 'private' AND group_id IS NULL) OR (visibility = 'shared' AND group_id IS NOT NULL)",
            name="ck_calendar_events_visibility_group",
        ),
        sa.CheckConstraint("ends_at > starts_at", name="ck_calendar_events_time_range"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
    )
    op.create_index("ix_calendar_events_private_scope", "calendar_events", ["created_by", "visibility", "deleted_at"])
    op.create_index("ix_calendar_events_group_scope", "calendar_events", ["group_id", "visibility", "deleted_at"])
    op.create_index("ix_calendar_events_starts_at", "calendar_events", ["starts_at"])

    op.create_table(
        "calendar_event_overrides",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("calendar_event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("occurrence_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cancelled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone", sa.String(length=100), nullable=True),
        sa.Column("all_day", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["calendar_event_id"], ["calendar_events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.UniqueConstraint("calendar_event_id", "occurrence_start", name="uq_calendar_event_override_occurrence"),
    )
    op.create_index("ix_calendar_event_overrides_event", "calendar_event_overrides", ["calendar_event_id"])

    op.create_table(
        "calendar_reminders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("calendar_event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("minutes_before", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["calendar_event_id"], ["calendar_events.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("calendar_event_id", "minutes_before", name="uq_calendar_reminders_event_offset"),
    )
    op.create_index("ix_calendar_reminders_event", "calendar_reminders", ["calendar_event_id"])


def downgrade() -> None:
    op.drop_index("ix_calendar_reminders_event", table_name="calendar_reminders")
    op.drop_table("calendar_reminders")
    op.drop_index("ix_calendar_event_overrides_event", table_name="calendar_event_overrides")
    op.drop_table("calendar_event_overrides")
    op.drop_index("ix_calendar_events_starts_at", table_name="calendar_events")
    op.drop_index("ix_calendar_events_group_scope", table_name="calendar_events")
    op.drop_index("ix_calendar_events_private_scope", table_name="calendar_events")
    op.drop_table("calendar_events")
    calendar_visibility.drop(op.get_bind(), checkfirst=True)
