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
    recurrence: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CalendarEventOverride(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "calendar_event_overrides"
    __table_args__ = (
        UniqueConstraint("calendar_event_id", "occurrence_start", name="uq_calendar_event_override_occurrence"),
        Index("ix_calendar_event_overrides_event", "calendar_event_id"),
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


class CalendarReminder(UUIDPrimaryKeyMixin, TimestampMixin, Base):
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
