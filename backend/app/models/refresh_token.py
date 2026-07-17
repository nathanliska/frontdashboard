import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RefreshToken(Base):
    """One row per token — never rotated in place.

    A rotation chain must be preserved: the grace window has to be able to look up
    a token that was consumed moments ago, and a single row can only remember one
    predecessor. Two tabs racing produce a chain, not a pair.

    revoked_at is a timestamp, not a boolean, because the grace window needs to
    know WHEN a token was consumed, not merely whether.
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("ix_refresh_tokens_user_active", "user_id", "revoked_at", "expires_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
