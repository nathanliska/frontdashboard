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

    The table is named for a polymorphism it does not have. Lists and calendar events **inherit**
    access from the dashboard that owns them ([ADR-001](../../../docs/adr/ADR-001-per-resource-sharing.md)),
    so both write paths pass `ResourceType.dashboard` literally.

    The discriminators are therefore pinned to their single live value by CHECK constraints, which
    is what makes the foreign keys expressible at all (#19) — a column that might point at any of
    three tables cannot reference one. `resource_id` is a real dashboard and `principal_id` a real
    user, enforced by the database rather than by remembering to check.

    Re-opening this to more resource types means dropping `ck_resource_shares_resource_type` and
    `fk_resource_shares_resource_id` together; the discriminator columns are kept precisely so that
    stays a migration rather than a redesign.
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
    # ON DELETE CASCADE: a grant on a dashboard that no longer exists is a row nothing can ever
    # read, so the reaper does not have to sweep these by hand in a safe order.
    resource_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("dashboards.id", name="fk_resource_shares_resource_id", ondelete="CASCADE"),
        nullable=False,
    )
    principal_type: Mapped[PrincipalType] = mapped_column(String(10), nullable=False)
    # No cascade, matching `granted_by`: users are only ever soft-deleted, so this never fires
    # today. If account deletion is ever built, the FK stops it until it decides what happens to
    # the dashboards this person could see — which is the question, not an obstacle to it.
    principal_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", name="fk_resource_shares_principal_id"),
        nullable=False,
    )
    role: Mapped[ShareRole] = mapped_column(String(20), nullable=False)
    granted_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
