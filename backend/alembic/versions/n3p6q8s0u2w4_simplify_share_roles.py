"""simplify share roles: drop contributor, rename manager to editor

Revision ID: n3p6q8s0u2w4
Revises: m2n5p7r9t1v3
Create Date: 2026-04-02

The permission model now uses two roles:
  viewer  — read-only access
  editor  — full editing (was 'manager'); replaces 'contributor' too

Both 'contributor' and 'manager' rows are promoted to 'editor'.
"""

from alembic import op

revision = "n3p6q8s0u2w4"
down_revision = "m2n5p7r9t1v3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE resource_shares SET role = 'editor' WHERE role IN ('contributor', 'manager')"
    )


def downgrade() -> None:
    # Restore 'editor' → 'manager'; 'contributor' rows are unrecoverable (promoted)
    op.execute(
        "UPDATE resource_shares SET role = 'manager' WHERE role = 'editor'"
    )
