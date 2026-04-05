"""drop legacy dashboard group ownership and deactivate group-backed shares

Revision ID: p4r7t9v1x3z5
Revises: n3p6q8s0u2w4
Create Date: 2026-04-03
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p4r7t9v1x3z5"
down_revision: str | Sequence[str] | None = "n3p6q8s0u2w4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()

    remaining_group_dashboards = bind.execute(
        sa.text("SELECT COUNT(*) FROM dashboards WHERE group_id IS NOT NULL")
    ).scalar_one()
    if remaining_group_dashboards:
        raise RuntimeError(
            "Cannot drop groups tables while dashboards.group_id still contains data"
        )

    missing_dashboard_owners = bind.execute(
        sa.text("SELECT COUNT(*) FROM dashboards WHERE user_id IS NULL")
    ).scalar_one()
    if missing_dashboard_owners:
        raise RuntimeError(
            "Cannot drop groups tables while dashboards.user_id contains NULL rows"
        )

    op.execute("DELETE FROM resource_shares WHERE principal_type = 'group'")

    op.execute("ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS ck_dashboards_owner")
    op.execute("ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_group_id_fkey")
    op.execute("ALTER TABLE dashboards DROP COLUMN IF EXISTS group_id")
    op.alter_column("dashboards", "user_id", nullable=False)

    # The old groups tables are no longer used by the registered API/runtime,
    # but dropping them requires heavyweight locks that can block local
    # development migrations. Leave the physical tables in place for now so the
    # active schema can continue evolving. A later cleanup migration can remove
    # them once the database is quiescent.


def downgrade() -> None:
    raise RuntimeError("Removing legacy dashboard group ownership is intentionally irreversible")
