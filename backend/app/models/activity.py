"""ActivityEvent model — append-only log of all mutations.

event_id is a BIGSERIAL-style incrementing integer (separate from UUID PK) used
as the SSE Last-Event-ID and a stable ordering key.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, Sequence, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

_event_id_seq = Sequence("activity_events_event_id_seq")


class EventType(enum.StrEnum):
    # Lists
    list_created = "list.created"
    list_updated = "list.updated"
    # No `list.archived`: archiving is gone. Historic rows keep the string — `event_type` is a
    # plain String column read back as `str`, so retired members never break the feed.
    list_deleted = "list.deleted"
    list_reordered = "list.reordered"
    # List items
    list_item_created = "list.item.created"
    list_item_updated = "list.item.updated"
    list_item_checked = "list.item.checked"
    list_item_deleted = "list.item.deleted"
    list_item_reordered = "list.item.reordered"
    # Dashboards
    dashboard_created = "dashboard.created"
    dashboard_updated = "dashboard.updated"
    dashboard_deleted = "dashboard.deleted"
    dashboard_share_added = "dashboard.share_added"
    dashboard_share_updated = "dashboard.share_updated"
    dashboard_share_removed = "dashboard.share_removed"
    # Calendar
    calendar_event_created = "calendar.event.created"
    calendar_event_updated = "calendar.event.updated"
    calendar_event_deleted = "calendar.event.deleted"
    calendar_event_occurrence_updated = "calendar.event.occurrence.updated"
    calendar_event_occurrence_cancelled = "calendar.event.occurrence.cancelled"


class ChangedField(enum.StrEnum):
    """What a `dashboard.updated` frame says changed, in `payload["changed_fields"]`.

    Clients branch on this to decide what to refetch, so it is a wire contract in both
    directions: `test_changed_fields_coverage.py` fails the build when a producer invents a
    value, and the members reach the frontend as a generated enum via `schemas/sse.py`.

    Whether a value implies the *dashboard row* changed is the load-bearing distinction —
    `widgets` alone does not, so `updated_at` does not move and summaries need no touch.
    The full per-value refetch table is in
    [FDR-008](../../../docs/fdr/FDR-008-realtime-sse.md).
    """

    # Bumps dashboard.version, so the row's updated_at moves with it.
    layout = "layout"
    # Widget set or a widget's config. Alone it touches no dashboard column.
    widgets = "widgets"
    name = "name"
    restored = "restored"
    # Recorded on dashboard.share_* frames for the activity log only; no client predicate reads
    # it, because those frames are identified by event_type instead.
    shares = "shares"


class ActivityEvent(Base):
    __tablename__ = "activity_events"
    __table_args__ = (
        Index("ix_activity_events_event_id", "event_id"),
        Index("ix_activity_events_actor", "actor_id", "created_at"),
    )
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Monotonically increasing integer; assigned by DB sequence; used as SSE Last-Event-ID
    event_id: Mapped[int] = mapped_column(
        BigInteger,
        _event_id_seq,
        nullable=False,
        unique=True,
    )
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # actor_id + actor_display_name snapshot — name preserved after user leaves/deletes
    actor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    actor_display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Polymorphic entity reference — no FK (can point to list, list_item, group_member, etc.)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    entity_version: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="1")
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
