import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class ResourceType(enum.StrEnum):
    list = "list"
    calendar_event = "calendar_event"
    dashboard = "dashboard"


class PrincipalType(enum.StrEnum):
    user = "user"
    group = "group"


class ShareRole(enum.StrEnum):
    viewer = "viewer"
    editor = "editor"


class ResourceShare(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "resource_shares"
    __table_args__ = (
        UniqueConstraint(
            "resource_type",
            "resource_id",
            "principal_type",
            "principal_id",
            name="uq_resource_shares_target",
        ),
        Index("ix_resource_shares_resource", "resource_type", "resource_id"),
        Index("ix_resource_shares_principal", "principal_type", "principal_id"),
    )

    resource_type: Mapped[str] = mapped_column(String(30), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    principal_type: Mapped[str] = mapped_column(String(10), nullable=False)
    principal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    granted_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
