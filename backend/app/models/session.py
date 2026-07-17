import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserSession(Base):
    """One row per login. Stable across refresh-token rotation, so it is the thing
    that can be named, revoked, and checked — which a rotating token cannot be.

    Named UserSession, not Session, to avoid colliding with SQLAlchemy's Session.

    Deliberately has no expires_at: a session's life is already bounded by its
    refresh token (7d), and a second expiry to keep in sync with the first would
    be a source of drift, not safety.
    """

    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_live", "user_id", "revoked_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    device_name: Mapped[str | None] = mapped_column(String, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    user_agent_hash: Mapped[str | None] = mapped_column(String, nullable=True)
