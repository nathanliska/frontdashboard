import uuid
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Dashboard(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboards"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False, server_default="My Dashboard")
    layout: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default="[]")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class DashboardWidget(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboard_widgets"
    __table_args__ = (Index("ix_dashboard_widgets_dashboard_id", "dashboard_id"),)

    dashboard_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    widget_type: Mapped[str] = mapped_column(String(50), nullable=False)
    widget_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    resource_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
