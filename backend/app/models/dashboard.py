import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

_OWNER_CHECK = "(user_id IS NOT NULL AND group_id IS NULL) OR (user_id IS NULL AND group_id IS NOT NULL)"


class Dashboard(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "dashboards"
    __table_args__ = (
        CheckConstraint(_OWNER_CHECK, name="ck_dashboards_owner"),
        Index(
            "uq_dashboards_user",
            "user_id",
            unique=True,
            postgresql_where="user_id IS NOT NULL",
        ),
        Index(
            "uq_dashboards_group",
            "group_id",
            unique=True,
            postgresql_where="group_id IS NOT NULL",
        ),
    )

    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("groups.id"), nullable=True)
    layout: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default='{"rows": []}')
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
