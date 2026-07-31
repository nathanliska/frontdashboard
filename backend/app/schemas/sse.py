"""SSE frame contract models — mirror the wire shapes built in app/sse/events.py.

These models are not used to serialize the actual stream (that stays hand-rolled dicts
for performance/streaming reasons); they exist purely so the SSE frame shapes are
visible in OpenAPI instead of being an undocumented raw EventSourceResponse. If these
ever disagree with app/sse/events.py, events.py is the source of truth — fix these.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict

from app.models.activity import EventType


class ActivitySsePayload(BaseModel):
    """The payload fields the frontend actually reads.

    All optional, and extras are allowed: payload shape varies per event_type, and the inner
    shapes are deliberately not modelled.
    """

    dashboard_id: str | None = None
    list_id: str | None = None
    client_mutation_id: str | None = None
    changed_fields: list[str] | None = None
    item_ids: list[str] | None = None
    list_ids: list[str] | None = None
    values: dict[str, Any] | None = None
    widget_id: str | None = None
    config: dict[str, Any] | None = None

    model_config = ConfigDict(extra="allow")


class ActivitySseEvent(BaseModel):
    event_id: int
    event_type: EventType  # makes the EventType enum appear in components (the generated event-name source)
    entity_type: str
    entity_id: str
    entity_version: int
    actor_id: str
    actor_display_name: str
    payload: ActivitySsePayload
    created_at: str


class NotificationSseEvent(BaseModel):
    """Matches notification_to_sse_dict payload.

    Every key is always present in the frame (the serializer writes them unconditionally) and
    `body` is NOT NULL on the model — so these are required, mirroring NotificationResponse.
    The frontend feeds this frame straight into the same store as the REST response.
    """

    id: str
    type: str
    title: str
    body: str
    reference_type: str | None
    reference_id: str | None
    read_at: str | None
    created_at: str


class ConnectedSseEvent(BaseModel):
    model_config = ConfigDict(extra="allow")  # data is {}


class ResyncSseEvent(BaseModel):
    reason: str


# Union used purely to register all frame models into OpenAPI components.
AnySseEvent = ActivitySseEvent | NotificationSseEvent | ConnectedSseEvent | ResyncSseEvent
