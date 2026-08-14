import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ListType(enum.StrEnum):
    checklist = "checklist"
    grocery = "grocery"
    todo = "todo"


class ItemPriority(enum.StrEnum):
    low = "low"
    medium = "medium"
    high = "high"


class List(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "lists"
    __table_args__ = (
        Index("ix_lists_dashboard_id", "dashboard_id", "deleted_at"),
        Index("ix_lists_created_by", "created_by", "deleted_at"),
        CheckConstraint("sort_order >= 0", name="ck_lists_sort_order_nonneg"),
    )

    dashboard_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dashboards.id"), nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    list_type: Mapped[ListType] = mapped_column(Enum(ListType, name="list_type"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # Set = "in the trash": hidden everywhere but the owner's trash view, restorable until the
    # reaper purges it. Lists had an `archived` flag too; it went the same way dashboards' did.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ListItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "list_items"
    __table_args__ = (
        Index("ix_list_items_list_id", "list_id", "sort_order", "deleted_at"),
        Index("ix_list_items_assigned_to", "assigned_to", "checked", "deleted_at"),
        # The per-creator quota counts every row a user owns, trashed included, so it carries no
        # `deleted_at` and the other two indexes cannot serve it.
        Index("ix_list_items_created_by", "created_by"),
        CheckConstraint("sort_order >= 0", name="ck_list_items_sort_order_nonneg"),
    )

    list_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("lists.id"), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    checked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    priority: Mapped[ItemPriority | None] = mapped_column(Enum(ItemPriority, name="item_priority"), nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
