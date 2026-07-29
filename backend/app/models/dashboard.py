import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Dashboard(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboards"
    # Every listing is "my live dashboards, newest first"; user_id lost its index when the
    # one-per-user unique constraint was dropped, so that query had nothing to use.
    __table_args__ = (Index("ix_dashboards_user_deleted_updated", "user_id", "deleted_at", "updated_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Trash (finding #40): set = "moved to trash", invisible everywhere but the owner's trash view,
    # restorable until the reaper purges it past `trash_retention_days`. The *only* put-away state —
    # two overlapping "hide this" concepts is one too many to explain (ADR-007).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    layout: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default="[]")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class DashboardWidget(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboard_widgets"
    __table_args__ = (
        Index("ix_dashboard_widgets_dashboard_id", "dashboard_id"),
        # "which dashboards show this list?" — the reverse lookup share cleanup and delete paths run.
        Index("ix_dashboard_widgets_resource", "resource_type", "resource_id", "dashboard_id"),
        # One widget per resource per dashboard. The router still checks first to return a friendly
        # 409, but the read-before-insert races itself under concurrent adds; this is the guarantee.
        Index(
            "uq_dashboard_widgets_resource_binding",
            "dashboard_id",
            "resource_type",
            "resource_id",
            unique=True,
            postgresql_where=text("resource_type IS NOT NULL AND resource_id IS NOT NULL"),
        ),
        # A widget binds a resource or it does not; half a binding is not a state the app can read.
        CheckConstraint(
            "(resource_type IS NULL) = (resource_id IS NULL)",
            name="ck_dashboard_widgets_resource_pair",
        ),
    )

    dashboard_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    widget_type: Mapped[str] = mapped_column(String(50), nullable=False)
    widget_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    resource_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
