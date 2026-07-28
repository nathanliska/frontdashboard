"""Convert JSONB 'null' recurrence values to real SQL NULL.

`calendar_events.recurrence` was declared as plain `JSONB`, and SQLAlchemy's JSON types default to
`none_as_null=False` — so a Python `None` was persisted as the JSONB *scalar* `null` rather than
SQL `NULL`. Reading it back gives `None` either way, so nothing in the application misbehaved and
no response body ever differed.

The damage was in SQL. `recurrence IS NOT NULL` is **true** for a JSONB null, so the occurrence
window query classified every non-recurring event as a recurring series; because
`recurrence['until']` on a JSONB null is NULL, each took the "unbounded series" branch, whose only
constraint is `starts_at < window_end`. The window's lower bound therefore never applied to one-off
events, and every past event loaded on every calendar request. Production held 33 such rows out of
41 live events.

This converts the existing rows; the model now sets `none_as_null=True` so no new ones are written.

Revision ID: k3n6q9t2w5y8
Revises: h9j2m5p7s9v1
"""

from alembic import op

revision = "k3n6q9t2w5y8"
down_revision = "h9j2m5p7s9v1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Deliberately keyed on jsonb_typeof rather than `= 'null'::jsonb`: the latter reads as an
    # equality test against SQL NULL to anyone skimming it, which is the exact confusion that
    # caused this bug.
    op.execute(
        """
        UPDATE calendar_events
        SET recurrence = NULL
        WHERE jsonb_typeof(recurrence) = 'null'
        """
    )


def downgrade() -> None:
    """Intentionally a no-op.

    The faithful inverse would rewrite SQL NULLs back to the JSONB scalar 'null', which is to say
    it would deliberately restore the bug. SQL NULL is valid under the old schema too — the old
    model simply never wrote it — so leaving the data converted is both harmless on the way down
    and correct on the way back up.
    """
