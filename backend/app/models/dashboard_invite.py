import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.share import ShareRole


class DashboardInvite(Base):
    """A single-use, expiring code that grants its holder a role on one dashboard.

    Shaped like the auth token tables on purpose: only the sha256 of the code is stored, so a
    leaked database row can't be redeemed, and `expires_at` lets the retention reaper prune it
    with the same sweep it runs over the other token tables. The raw code is returned exactly
    once, when the invite is created.

    Possession of the code *is* the credential — there is no email binding — so the controls are
    single use (`used_at`), a short TTL, and owner revocation (`revoked_at`).
    """

    __tablename__ = "dashboard_invites"
    __table_args__ = (Index("ix_dashboard_invites_dashboard_active", "dashboard_id", "used_at", "revoked_at", "expires_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dashboard_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("dashboards.id", ondelete="CASCADE"),
        nullable=False,
    )
    code_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    role: Mapped[ShareRole] = mapped_column(String(20), nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    redeemed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
