"""Collapse auth onto one opaque session cookie.

The access/refresh split is removed (ADR-003, amended). `sessions` grows the SHA-256 of the
opaque token that now *is* the credential, plus the absolute-expiry bound the old model never
had, and `refresh_tokens` goes away entirely.

**Every existing session dies here, deliberately.** A session issued before this migration has
no `token_hash` and no way to acquire one — the raw token only ever existed in a cookie we do
not have. Rather than leave rows that can never authenticate, the table is emptied so the new
NOT NULL columns can be added without a fabricated default that would misrepresent them as real
sessions. Users re-authenticate once.

`refresh_tokens` is dropped in this same migration rather than a later one because
`tests/test_migrations.py` runs `alembic check`: a table with no model is drift, and would fail
the build between the two migrations.

Revision ID: n7r0v3y6c9e2
Revises: m5q8t1w4z7b0
"""

import sqlalchemy as sa
from alembic import op

revision = "n7r0v3y6c9e2"
down_revision = "m5q8t1w4z7b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # refresh_tokens first: its session_id FK would otherwise block the sessions delete.
    op.drop_table("refresh_tokens")
    op.execute("DELETE FROM sessions")

    op.add_column("sessions", sa.Column("token_hash", sa.String(), nullable=False))
    op.add_column("sessions", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False))
    op.alter_column("sessions", "last_used_at", nullable=False)
    op.create_index("ix_sessions_token_hash", "sessions", ["token_hash"], unique=True)


def downgrade() -> None:
    """Refuses, unlike the no-op downgrades on the data-only migrations here.

    This one changes the schema, so a no-op would move `alembic_version` back while leaving the
    schema forward — and the next `upgrade` would then fail dropping a table that is already gone.
    """
    raise NotImplementedError("n7r0v3y6c9e2 is not reversible — restore from a backup instead (#35).")
