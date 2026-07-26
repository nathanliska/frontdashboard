"""Add dashboards.deleted_at — the trash lifecycle (finding #40).

DELETE stops being permanent: it stamps deleted_at, the dashboard disappears from every listing
and access path, and the reaper purges it (children included) after the retention window. NULL
for every existing row: nothing is in the trash yet.

Revision ID: f7h0k3n5q7t9
Revises: e5g8j1m3p5r7
Create Date: 2026-07-26
"""

import sqlalchemy as sa

from alembic import op

revision = "f7h0k3n5q7t9"
down_revision = "e5g8j1m3p5r7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dashboards", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("dashboards", "deleted_at")
