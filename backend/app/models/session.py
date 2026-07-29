import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserSession(Base):
    """One row per login, and the *whole* credential (ADR-003).

    `token_hash` is the SHA-256 of the opaque token in the `session` cookie — the raw value is never
    stored, so a database disclosure yields nothing usable. Nothing sits beside it: every request
    resolves this row, which is what makes revocation immediate.

    Named UserSession, not Session, to avoid colliding with SQLAlchemy's Session.

    Two clocks, because one is not enough (OWASP Session Management):
      - `last_used_at` — the **idle** bound, slid forward as the session is used.
      - `expires_at`   — the **absolute** bound, fixed at login and never extended. Without it a
        session in daily use would slide forever and never expire.
    """

    __tablename__ = "sessions"
    __table_args__ = (
        Index("ix_sessions_user_live", "user_id", "revoked_at"),
        Index("ix_sessions_token_hash", "token_hash", unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # Not nullable: both are read by the liveness predicate on every single request, and a NULL
    # there would have to mean either "never expires" or "always expired" — neither is a thing.
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    device_name: Mapped[str | None] = mapped_column(String, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    user_agent_hash: Mapped[str | None] = mapped_column(String, nullable=True)
