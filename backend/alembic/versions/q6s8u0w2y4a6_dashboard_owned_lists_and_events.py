"""make lists and calendar events dashboard-owned

Revision ID: q6s8u0w2y4a6
Revises: p4r7t9v1x3z5
Create Date: 2026-04-03
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "q6s8u0w2y4a6"
down_revision: str | Sequence[str] | None = "p4r7t9v1x3z5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ensure_dashboard_for_owner(
    bind: sa.Connection,
    user_id: uuid.UUID,
    cache: dict[uuid.UUID, uuid.UUID],
) -> uuid.UUID:
    if user_id in cache:
        return cache[user_id]

    existing_dashboard_id = bind.execute(
        sa.text(
            """
            SELECT id
            FROM dashboards
            WHERE user_id = :user_id
            ORDER BY is_favorite DESC, created_at ASC
            LIMIT 1
            """
        ),
        {"user_id": user_id},
    ).scalar_one_or_none()
    if existing_dashboard_id is not None:
        cache[user_id] = existing_dashboard_id
        return existing_dashboard_id

    dashboard_id = uuid.uuid4()
    bind.execute(
        sa.text(
            """
            INSERT INTO dashboards (id, user_id, name, is_favorite, layout, version, created_at, updated_at)
            VALUES (:id, :user_id, :name, false, '[]'::jsonb, 0, now(), now())
            """
        ),
        {
            "id": dashboard_id,
            "user_id": user_id,
            "name": "Migrated Dashboard",
        },
    )
    cache[user_id] = dashboard_id
    return dashboard_id


def _backfill_lists(bind: sa.Connection) -> None:
    dashboard_cache: dict[uuid.UUID, uuid.UUID] = {}
    assigned_list_ids: set[uuid.UUID] = set()

    widget_rows = bind.execute(
        sa.text(
            """
            SELECT l.id, l.created_by, dw.dashboard_id
            FROM lists AS l
            JOIN dashboard_widgets AS dw
              ON dw.resource_type = 'list'
             AND dw.resource_id = l.id
            WHERE l.dashboard_id IS NULL
            ORDER BY dw.created_at ASC
            """
        )
    ).all()
    for row in widget_rows:
        if row.id in assigned_list_ids:
            continue
        bind.execute(
            sa.text("UPDATE lists SET dashboard_id = :dashboard_id WHERE id = :list_id"),
            {"dashboard_id": row.dashboard_id, "list_id": row.id},
        )
        assigned_list_ids.add(row.id)
        dashboard_cache[row.created_by] = row.dashboard_id

    list_rows = bind.execute(
        sa.text("SELECT id, created_by FROM lists WHERE dashboard_id IS NULL")
    ).all()
    for row in list_rows:
        dashboard_id = _ensure_dashboard_for_owner(bind, row.created_by, dashboard_cache)
        bind.execute(
            sa.text("UPDATE lists SET dashboard_id = :dashboard_id WHERE id = :list_id"),
            {"dashboard_id": dashboard_id, "list_id": row.id},
        )


def _backfill_calendar_events(bind: sa.Connection) -> None:
    dashboard_cache: dict[uuid.UUID, uuid.UUID] = {}
    event_rows = bind.execute(
        sa.text("SELECT id, created_by FROM calendar_events WHERE dashboard_id IS NULL")
    ).all()
    for row in event_rows:
        dashboard_id = _ensure_dashboard_for_owner(bind, row.created_by, dashboard_cache)
        bind.execute(
            sa.text("UPDATE calendar_events SET dashboard_id = :dashboard_id WHERE id = :event_id"),
            {"dashboard_id": dashboard_id, "event_id": row.id},
        )


def upgrade() -> None:
    bind = op.get_bind()

    op.add_column(
        "lists",
        sa.Column("dashboard_id", sa.UUID(as_uuid=True), sa.ForeignKey("dashboards.id"), nullable=True),
    )
    op.add_column(
        "calendar_events",
        sa.Column("dashboard_id", sa.UUID(as_uuid=True), sa.ForeignKey("dashboards.id"), nullable=True),
    )

    _backfill_lists(bind)
    _backfill_calendar_events(bind)

    missing_lists = bind.execute(
        sa.text("SELECT COUNT(*) FROM lists WHERE dashboard_id IS NULL")
    ).scalar_one()
    if missing_lists:
        raise RuntimeError("Cannot finalize dashboard-owned lists while NULL dashboard_id rows remain")

    missing_events = bind.execute(
        sa.text("SELECT COUNT(*) FROM calendar_events WHERE dashboard_id IS NULL")
    ).scalar_one()
    if missing_events:
        raise RuntimeError("Cannot finalize dashboard-owned calendar events while NULL dashboard_id rows remain")

    op.execute("DROP INDEX IF EXISTS ix_lists_dashboard_id")
    op.execute("DROP INDEX IF EXISTS ix_lists_created_by")
    op.create_index("ix_lists_dashboard_id", "lists", ["dashboard_id", "deleted_at"])
    op.create_index("ix_lists_created_by", "lists", ["created_by", "deleted_at"])
    op.alter_column("lists", "dashboard_id", nullable=False)

    op.execute("DROP INDEX IF EXISTS ix_calendar_events_dashboard_id")
    op.execute("DROP INDEX IF EXISTS ix_calendar_events_private_scope")
    op.execute("DROP INDEX IF EXISTS ix_calendar_events_group_scope")
    op.execute("DROP INDEX IF EXISTS ix_calendar_events_created_by")
    op.create_index("ix_calendar_events_dashboard_id", "calendar_events", ["dashboard_id", "deleted_at"])
    op.create_index("ix_calendar_events_created_by", "calendar_events", ["created_by", "deleted_at"])
    op.alter_column("calendar_events", "dashboard_id", nullable=False)

    op.execute(
        "DELETE FROM resource_shares WHERE resource_type IN ('list', 'calendar_event')"
    )


def downgrade() -> None:
    raise RuntimeError("Migrating lists and calendar events to dashboard ownership is intentionally irreversible")
