"""add dashboard/widget indexes and domain invariants

Revision ID: e5g8j1m3p5r7
Revises: d3f6h8k0m2p4
Create Date: 2026-07-26

Indexes the two access paths that had none, and moves two invariants the application already
assumes into the database:

- ``dashboards.user_id`` lost its index when the one-dashboard-per-user unique constraint was
  dropped, so the listing query ("my non-archived dashboards, newest first") had nothing to use.
- Widget reverse lookups (``which dashboards show this list?``) ran unindexed on every share
  cleanup and resource delete.
- One widget per resource per dashboard was enforced only by a read-before-insert, which races
  itself when two adds arrive together.
- A widget binds a resource or it does not; half a binding is unreadable to the app.
- An override that retimes an occurrence must not end before it starts, matching the parent event.

The partial unique index is created CONCURRENTLY-free on purpose: these tables are small at this
deployment's scale, and a plain CREATE INDEX inside the migration transaction keeps the upgrade
atomic. Revisit if the tables ever get large enough for the lock to matter.
"""

import sqlalchemy as sa

from alembic import op

revision = "e5g8j1m3p5r7"
down_revision = "d3f6h8k0m2p4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_dashboards_user_archived_updated",
        "dashboards",
        ["user_id", "archived", "updated_at"],
    )
    op.create_index(
        "ix_dashboard_widgets_resource",
        "dashboard_widgets",
        ["resource_type", "resource_id", "dashboard_id"],
    )

    # Existing rows could violate either constraint, so clean before constraining rather than
    # letting the upgrade fail on someone's data.
    op.execute(
        """
        UPDATE dashboard_widgets
           SET resource_type = NULL, resource_id = NULL
         WHERE (resource_type IS NULL) <> (resource_id IS NULL)
        """
    )
    # Keep the oldest widget for each duplicated binding; the later ones were never reachable as
    # distinct content anyway.
    op.execute(
        """
        DELETE FROM dashboard_widgets dw
         WHERE dw.resource_type IS NOT NULL
           AND dw.resource_id IS NOT NULL
           AND EXISTS (
               SELECT 1
                 FROM dashboard_widgets keep
                WHERE keep.dashboard_id = dw.dashboard_id
                  AND keep.resource_type = dw.resource_type
                  AND keep.resource_id = dw.resource_id
                  AND (keep.created_at, keep.id) < (dw.created_at, dw.id)
           )
        """
    )

    op.create_index(
        "uq_dashboard_widgets_resource_binding",
        "dashboard_widgets",
        ["dashboard_id", "resource_type", "resource_id"],
        unique=True,
        postgresql_where=sa.text("resource_type IS NOT NULL AND resource_id IS NOT NULL"),
    )
    op.create_check_constraint(
        "ck_dashboard_widgets_resource_pair",
        "dashboard_widgets",
        "(resource_type IS NULL) = (resource_id IS NULL)",
    )

    op.execute(
        """
        UPDATE calendar_event_overrides
           SET starts_at = NULL, ends_at = NULL
         WHERE starts_at IS NOT NULL
           AND ends_at IS NOT NULL
           AND ends_at <= starts_at
        """
    )
    op.create_check_constraint(
        "ck_calendar_event_overrides_time_range",
        "calendar_event_overrides",
        "starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at",
    )


def downgrade() -> None:
    op.drop_constraint("ck_calendar_event_overrides_time_range", "calendar_event_overrides", type_="check")
    op.drop_constraint("ck_dashboard_widgets_resource_pair", "dashboard_widgets", type_="check")
    op.drop_index("uq_dashboard_widgets_resource_binding", table_name="dashboard_widgets")
    op.drop_index("ix_dashboard_widgets_resource", table_name="dashboard_widgets")
    op.drop_index("ix_dashboards_user_archived_updated", table_name="dashboards")
