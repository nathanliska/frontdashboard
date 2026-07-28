"""Snap existing all-day events to whole local days.

`all_day` was a passthrough flag — whatever times the client sent were stored verbatim — so
production accumulated all-day events starting at 09:00 local (20 of 25 of them). The end was
already local midnight, so the window predicate still returned them correctly; what was wrong is
that the agenda sorts by `starts_at` and filed them among the timed events, and that the flag did
not mean what it says.

The routers normalize from now on; this converts what is already stored.

Expressed in SQL rather than a Python loop because `AT TIME ZONE` does the work directly and reads
as the same operation the service performs: to local time, truncate to the day, back to UTC. The
end keeps the exclusive-midnight convention the rows already use — a sub-microsecond step back
before truncating is what stops an end already at midnight from gaining a day.

Revision ID: m5q8t1w4z7b0
Revises: k3n6q9t2w5y8
"""

from alembic import op

revision = "m5q8t1w4z7b0"
down_revision = "k3n6q9t2w5y8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE calendar_events
        SET starts_at = (date_trunc('day', starts_at AT TIME ZONE timezone)) AT TIME ZONE timezone,
            ends_at   = (date_trunc('day', (ends_at AT TIME ZONE timezone) - interval '1 microsecond')
                         + interval '1 day') AT TIME ZONE timezone
        WHERE all_day
        """
    )


def downgrade() -> None:
    """Intentionally a no-op.

    The original times are not recoverable — they were overwritten, not moved aside — and whole
    local days are valid under the previous schema anyway, which stored whatever it was given.
    """
