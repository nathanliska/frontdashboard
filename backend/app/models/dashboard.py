import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Dashboard(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboards"
    # Every listing is "my live dashboards, newest first", and user_id has no index of its own.
    __table_args__ = (Index("ix_dashboards_user_deleted_updated", "user_id", "deleted_at", "updated_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Trash: invisible everywhere but the owner's trash view, restorable until the reaper purges
    # it past `trash_retention_days`. The only put-away state there is (ADR-007).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    layout: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default="[]")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class DashboardWidget(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboard_widgets"
    __table_args__ = (
        Index("ix_dashboard_widgets_dashboard_id", "dashboard_id"),
        Index("ix_dashboard_widgets_list_id", "list_id"),
        # One widget per list per dashboard. The add path still checks first to return a friendly
        # 409, but the read-before-insert races itself under concurrent adds; this is the guarantee.
        Index(
            "uq_dashboard_widgets_list",
            "dashboard_id",
            "list_id",
            unique=True,
            postgresql_where=text("list_id IS NOT NULL"),
        ),
    )

    dashboard_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    widget_type: Mapped[str] = mapped_column(String(50), nullable=False)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    # The list a list widget shows. Cascades as a backstop only:
    # trashing a list unbinds its widgets first, so their layout entries go with them.
    list_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("lists.id", name="fk_dashboard_widgets_list_id", ondelete="CASCADE"),
        nullable=True,
    )
