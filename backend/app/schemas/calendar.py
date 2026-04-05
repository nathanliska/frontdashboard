import uuid
from datetime import datetime
from typing import Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _ensure_aware(dt: datetime, field_name: str) -> None:
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError(f"{field_name} must include timezone information")


def _ensure_timezone_exists(name: str) -> None:
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:  # pragma: no cover - simple validation branch
        raise ValueError("timezone must be a valid IANA timezone") from exc


class RecurrenceRule(BaseModel):
    frequency: str = Field(pattern="^(daily|weekly|monthly|yearly)$")
    interval: int = Field(default=1, ge=1, le=366)
    by_weekday: list[int] | None = None
    until: datetime | None = None
    count: int | None = Field(default=None, ge=1, le=1000)

    @model_validator(mode="after")
    def check_rule(self) -> Self:
        if self.until is not None:
            _ensure_aware(self.until, "until")

        if self.frequency == "weekly":
            weekdays = self.by_weekday or []
            if not weekdays:
                raise ValueError("by_weekday is required for weekly recurrence")
            if any(day < 0 or day > 6 for day in weekdays):
                raise ValueError("by_weekday values must be between 0 and 6")
        elif self.by_weekday is not None:
            raise ValueError("by_weekday is only valid for weekly recurrence")

        return self


class CalendarEventBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    location: str | None = Field(default=None, max_length=200)
    starts_at: datetime
    ends_at: datetime
    timezone: str = Field(min_length=1, max_length=100)
    all_day: bool = False
    recurrence: RecurrenceRule | None = None

    @model_validator(mode="after")
    def check_event(self) -> Self:
        _ensure_aware(self.starts_at, "starts_at")
        _ensure_aware(self.ends_at, "ends_at")
        _ensure_timezone_exists(self.timezone)

        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")

        if self.recurrence and self.recurrence.until and self.recurrence.until <= self.starts_at:
            raise ValueError("recurrence until must be after starts_at")

        return self


class CalendarEventCreate(CalendarEventBase):
    dashboard_id: uuid.UUID


class CalendarEventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    location: str | None = Field(default=None, max_length=200)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=100)
    all_day: bool | None = None
    recurrence: RecurrenceRule | None = None

    @model_validator(mode="after")
    def check_event(self) -> Self:
        if self.starts_at is not None:
            _ensure_aware(self.starts_at, "starts_at")
        if self.ends_at is not None:
            _ensure_aware(self.ends_at, "ends_at")
        if self.timezone is not None:
            _ensure_timezone_exists(self.timezone)
        if self.starts_at is not None and self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        return self


class CalendarOccurrenceUpdate(BaseModel):
    occurrence_start: datetime
    cancelled: bool = False
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    location: str | None = Field(default=None, max_length=200)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=100)
    all_day: bool | None = None

    @model_validator(mode="after")
    def check_override(self) -> Self:
        _ensure_aware(self.occurrence_start, "occurrence_start")
        if self.starts_at is not None:
            _ensure_aware(self.starts_at, "starts_at")
        if self.ends_at is not None:
            _ensure_aware(self.ends_at, "ends_at")
        if (self.starts_at is None) != (self.ends_at is None):
            raise ValueError("starts_at and ends_at must be provided together")
        if self.starts_at is not None and self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.timezone is not None:
            _ensure_timezone_exists(self.timezone)
        return self


class CalendarEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dashboard_id: uuid.UUID
    title: str
    description: str | None
    location: str | None
    starts_at: datetime
    ends_at: datetime
    timezone: str
    all_day: bool
    created_by: uuid.UUID
    updated_by: uuid.UUID
    recurrence: RecurrenceRule | None
    created_at: datetime
    updated_at: datetime


class CalendarOccurrenceResponse(BaseModel):
    event_id: uuid.UUID
    occurrence_start: datetime
    occurrence_end: datetime
    original_start: datetime
    title: str
    description: str | None
    location: str | None
    timezone: str
    all_day: bool
    created_by: uuid.UUID
    recurring: bool
    is_exception: bool


class CalendarOccurrenceMutationResponse(BaseModel):
    cancelled: bool
    occurrence: CalendarOccurrenceResponse | None = None
