import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    type: str
    title: str
    body: str
    group_id: uuid.UUID | None
    reference_type: str | None
    reference_id: uuid.UUID | None
    read_at: datetime | None
    created_at: datetime


class ActivityEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    event_id: int
    event_type: str
    group_id: uuid.UUID | None
    entity_type: str
    entity_id: uuid.UUID
    actor_id: uuid.UUID
    actor_display_name: str
    payload: dict
    created_at: datetime
