"""Give resource_shares real foreign keys by pinning its dead polymorphism

`resource_shares.resource_id` has never had a foreign key, because it was designed to point at a
list, a calendar event *or* a dashboard depending on `resource_type`, and no single FK can express
that. The polymorphism has since died: lists and calendar events inherit access from the dashboard
that owns them, their `/shares` endpoints are 409 stubs, revision `q6s8u0w2y4a6` deleted the last
of their share rows, and both write paths pass `'dashboard'` literally.

So this pins the discriminators to their one live value with CHECK constraints, which makes the
foreign keys expressible — `resource_id` to `dashboards`, `principal_id` to `users` (#19).

The four deletes below should each remove zero rows on a database that only ever ran this app: two
of them re-do what `q6s8u0w2y4a6` already did, and the reaper deletes share rows in the same
transaction as the dashboards they name. They run anyway because an FK that fails halfway through a
deploy leaves the schema behind the code, and any row they *do* find is unreadable by definition —
access resolution starts from the resource, so a share naming a dashboard or user that no longer
exists can never grant anything.

`resource_id` cascades on delete: a grant on a purged dashboard is not recoverable state. The trash
reaper used to delete those rows by hand, ordered so that an interrupted sweep left orphaned shares
rather than shares-less resources; the cascade makes it one atomic statement and retires that
argument along with the code.

Revision ID: h9j2m5p7s9v1
Revises: g8i1l4o6r8u0
Create Date: 2026-07-27
"""

from alembic import op

revision = "h9j2m5p7s9v1"
down_revision = "g8i1l4o6r8u0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DELETE FROM resource_shares WHERE resource_type <> 'dashboard'")
    op.execute("DELETE FROM resource_shares WHERE principal_type <> 'user'")
    op.execute(
        """
        DELETE FROM resource_shares s
        WHERE NOT EXISTS (SELECT 1 FROM dashboards d WHERE d.id = s.resource_id)
        """
    )
    op.execute(
        """
        DELETE FROM resource_shares s
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.principal_id)
        """
    )

    op.create_check_constraint(
        "ck_resource_shares_resource_type",
        "resource_shares",
        "resource_type = 'dashboard'",
    )
    op.create_check_constraint(
        "ck_resource_shares_principal_type",
        "resource_shares",
        "principal_type = 'user'",
    )
    op.create_foreign_key(
        "fk_resource_shares_resource_id",
        "resource_shares",
        "dashboards",
        ["resource_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_resource_shares_principal_id",
        "resource_shares",
        "users",
        ["principal_id"],
        ["id"],
    )


def downgrade() -> None:
    # Purely subtractive: the rows deleted on the way up were unreadable, so there is nothing to
    # put back — only the constraints to lift.
    op.drop_constraint("fk_resource_shares_principal_id", "resource_shares", type_="foreignkey")
    op.drop_constraint("fk_resource_shares_resource_id", "resource_shares", type_="foreignkey")
    op.drop_constraint("ck_resource_shares_principal_type", "resource_shares", type_="check")
    op.drop_constraint("ck_resource_shares_resource_type", "resource_shares", type_="check")
