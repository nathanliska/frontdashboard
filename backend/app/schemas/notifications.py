import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    type: str
    title: str
    body: str
    reference_type: str | None
    reference_id: uuid.UUID | None
    read_at: datetime | None
    created_at: datetime


class NotificationPageResponse(BaseModel):
    """One page of the notification list (finding #22).

    `next_cursor` is opaque to the client — it encodes the compound sort position (unread
    section, created_at, id) server-side, so the client never re-derives the ordering rules.
    Null means the history is exhausted.
    """

    items: list[NotificationResponse]
    next_cursor: str | None


class UnreadCountResponse(BaseModel):
    """Typed so the count endpoint appears in OpenAPI as a shape, not a bare object."""

    count: int


class ActivityEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    event_id: int
    event_type: str
    entity_type: str
    entity_id: uuid.UUID
    actor_id: uuid.UUID
    actor_display_name: str
    payload: dict
    created_at: datetime
