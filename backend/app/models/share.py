import enum
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin


class ResourceType(enum.StrEnum):
    list = "list"
    calendar_event = "calendar_event"
    dashboard = "dashboard"


class PrincipalType(enum.StrEnum):
    user = "user"


class ShareRole(enum.StrEnum):
    viewer = "viewer"
    editor = "editor"


class ResourceShare(UUIDPrimaryKeyMixin, Base):
    """A direct grant of one dashboard to one user.

    The table is named for a polymorphism it does not have: lists and events inherit access from
    their dashboard (ADR-001). CHECK constraints pin the discriminators to their one live value,
    which is what lets `resource_id` carry a real foreign key. Re-opening it to more resource
    types means dropping that CHECK and the FK together — a migration, not a redesign.
    """

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
        CheckConstraint("resource_type = 'dashboard'", name="ck_resource_shares_resource_type"),
        CheckConstraint("principal_type = 'user'", name="ck_resource_shares_principal_type"),
    )

    resource_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # Cascades: a grant on a deleted dashboard is unreadable, so the reaper need not sweep these.
    resource_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("dashboards.id", name="fk_resource_shares_resource_id", ondelete="CASCADE"),
        nullable=False,
    )
    principal_type: Mapped[PrincipalType] = mapped_column(String(10), nullable=False)
    # No cascade, matching `granted_by`: if account deletion is ever built, this FK blocks it
    # until it decides what happens to the dashboards the person could see.
    principal_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", name="fk_resource_shares_principal_id"),
        nullable=False,
    )
    role: Mapped[ShareRole] = mapped_column(String(20), nullable=False)
    granted_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
