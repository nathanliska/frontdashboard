"""constrain stored roles

Revision ID: e0d00a65b16f
Revises: n7r0v3y6c9e2
Create Date: 2026-08-08

`resource_shares.role` and `dashboard_invites.role` were unconstrained VARCHAR(20): the API
rejects anything outside the storable subset, but the database accepted any string, and a row
holding one 500s every access resolution that reads it. No data fix is needed first — invites
postdate the contributor/manager promotion (n3p6q8s0u2w4), and shares were cleaned by it.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e0d00a65b16f"
down_revision: str | Sequence[str] | None = "n7r0v3y6c9e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STORABLE_ROLES = "role IN ('viewer', 'editor')"


def upgrade() -> None:
    """Pin both role columns to the storable subset, matching the sibling discriminator CHECKs."""
    op.create_check_constraint("ck_resource_shares_role", "resource_shares", _STORABLE_ROLES)
    op.create_check_constraint("ck_dashboard_invites_role", "dashboard_invites", _STORABLE_ROLES)


def downgrade() -> None:
    """Drop both CHECKs; the columns revert to unconstrained VARCHAR."""
    op.drop_constraint("ck_resource_shares_role", "resource_shares", type_="check")
    op.drop_constraint("ck_dashboard_invites_role", "dashboard_invites", type_="check")
