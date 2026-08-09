import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)  # noqa: F401 (CheckConstraint still used by time_range)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class CalendarEvent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "calendar_events"
    __table_args__ = (
        CheckConstraint("ends_at > starts_at", name="ck_calendar_events_time_range"),
        Index("ix_calendar_events_dashboard_id", "dashboard_id", "deleted_at"),
        Index("ix_calendar_events_created_by", "created_by", "deleted_at"),
        Index("ix_calendar_events_starts_at", "starts_at"),
    )

    dashboard_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dashboards.id"), nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    timezone: Mapped[str] = mapped_column(String(100), nullable=False)
    all_day: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    # none_as_null=True is load-bearing, not decoration. SQLAlchemy's JSON types default to
    # none_as_null=False, which persists a Python None as the JSONB scalar 'null' rather than SQL
    # NULL. Python reads it back as None either way, so the application never noticed — but in SQL
    # `recurrence IS NOT NULL` then matched every one-off event, and the occurrence window query
    # classified all of them as unbounded recurring series (finding surfaced by auditing prod:
    # 33 of 41 live events held a JSONB null).
    recurrence: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CalendarEventOverride(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "calendar_event_overrides"
    __table_args__ = (
        UniqueConstraint("calendar_event_id", "occurrence_start", name="uq_calendar_event_override_occurrence"),
        Index("ix_calendar_event_overrides_event", "calendar_event_id"),
        # Mirrors the parent event's time-range check. Both columns are nullable here because an
        # override may retime an occurrence or leave its timing alone, so the constraint only binds
        # when both are supplied.
        # Occurrence *membership* — that occurrence_start is a real instance of the parent's
        # recurrence rule — deliberately stays in the application: expressing it needs RRULE
        # expansion, which is not something a CHECK can do.
        CheckConstraint(
            "starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at",
            name="ck_calendar_event_overrides_time_range",
        ),
    )

    calendar_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("calendar_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    occurrence_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    cancelled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    timezone: Mapped[str | None] = mapped_column(String(100), nullable=True)
    all_day: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class CalendarEventParticipant(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A household member attached to an event — a label for "whose thing is this", not a grant.

    Series-level on purpose: one set for the whole recurring event, never per-occurrence
    (FDR-006). Access still flows from the dashboard alone; rows survive an unshare so the
    event keeps naming its people, and the reader renders a departed member from the user row.
    """

    __tablename__ = "calendar_event_participants"
    __table_args__ = (
        UniqueConstraint("calendar_event_id", "user_id", name="uq_calendar_event_participants_member"),
        Index("ix_calendar_event_participants_event", "calendar_event_id"),
    )

    calendar_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("calendar_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)


class CalendarReminder(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Reserved schema for a not-yet-built "notify me N minutes before" feature.

    Deliberately has no router, service or reader, and nothing writes to it — kept rather than
    dropped (decided 2026-07-25, see FDR-006). Don't remove it as dead code; delivering it needs a
    scheduler, notification delivery, per-user opt-in and timezone handling first. Unrelated to the
    agenda widget's "reminders", which are list items with a due date.
    """

    __tablename__ = "calendar_reminders"
    __table_args__ = (
        UniqueConstraint("calendar_event_id", "minutes_before", name="uq_calendar_reminders_event_offset"),
        Index("ix_calendar_reminders_event", "calendar_event_id"),
    )

    calendar_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("calendar_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    minutes_before: Mapped[int] = mapped_column(Integer, nullable=False)
