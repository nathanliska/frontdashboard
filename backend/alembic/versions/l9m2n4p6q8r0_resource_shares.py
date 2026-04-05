"""resource shares — replace visibility/group_id with resource_shares table

Revision ID: l9m2n4p6q8r0
Revises: j7k2l4m6n8p0
Create Date: 2026-04-02

Removes:
  - lists.visibility, lists.group_id, ck_lists_visibility_group
  - calendar_events.visibility, calendar_events.group_id, ck_calendar_events_visibility_group
  - group_members.dashboard_role
  - Enum types: list_visibility, calendar_visibility, dashboard_role

Adds:
  - resource_shares table (polymorphic: list | calendar_event | dashboard)
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "l9m2n4p6q8r0"
down_revision: str | None = "j7k2l4m6n8p0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # resource_shares
    # ------------------------------------------------------------------
    op.create_table(
        "resource_shares",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("resource_type", sa.String(30), nullable=False),
        sa.Column("resource_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("principal_type", sa.String(10), nullable=False),
        sa.Column("principal_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column(
            "granted_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "resource_type",
            "resource_id",
            "principal_type",
            "principal_id",
            name="uq_resource_shares_target",
        ),
    )
    op.create_index(
        "ix_resource_shares_resource",
        "resource_shares",
        ["resource_type", "resource_id"],
    )
    op.create_index(
        "ix_resource_shares_principal",
        "resource_shares",
        ["principal_type", "principal_id"],
    )

    # ------------------------------------------------------------------
    # lists — drop visibility + group_id
    # ------------------------------------------------------------------
    op.drop_constraint("ck_lists_visibility_group", "lists", type_="check")
    op.drop_index("ix_lists_group_id", table_name="lists")
    op.drop_index("ix_lists_created_by", table_name="lists")
    op.drop_column("lists", "visibility")
    op.drop_column("lists", "group_id")
    op.create_index("ix_lists_created_by", "lists", ["created_by", "deleted_at"])
    op.execute("DROP TYPE IF EXISTS list_visibility")

    # ------------------------------------------------------------------
    # calendar_events — drop visibility + group_id
    # ------------------------------------------------------------------
    op.drop_constraint("ck_calendar_events_visibility_group", "calendar_events", type_="check")
    op.drop_index("ix_calendar_events_private_scope", table_name="calendar_events")
    op.drop_index("ix_calendar_events_group_scope", table_name="calendar_events")
    op.drop_column("calendar_events", "visibility")
    op.drop_column("calendar_events", "group_id")
    op.create_index(
        "ix_calendar_events_created_by",
        "calendar_events",
        ["created_by", "deleted_at"],
    )
    op.execute("DROP TYPE IF EXISTS calendar_visibility")

    # ------------------------------------------------------------------
    # group_members — drop dashboard_role
    # ------------------------------------------------------------------
    op.drop_column("group_members", "dashboard_role")
    op.execute("DROP TYPE IF EXISTS dashboard_role")


def downgrade() -> None:
    # Re-add dashboard_role to group_members
    op.execute("CREATE TYPE dashboard_role AS ENUM ('viewer', 'editor')")
    op.add_column(
        "group_members",
        sa.Column(
            "dashboard_role",
            sa.Enum("viewer", "editor", name="dashboard_role"),
            nullable=False,
            server_default="viewer",
        ),
    )

    # Re-add visibility + group_id to calendar_events
    op.execute("CREATE TYPE calendar_visibility AS ENUM ('private', 'shared')")
    op.drop_index("ix_calendar_events_created_by", table_name="calendar_events")
    op.add_column(
        "calendar_events",
        sa.Column(
            "group_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("groups.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "calendar_events",
        sa.Column(
            "visibility",
            sa.Enum("private", "shared", name="calendar_visibility"),
            nullable=False,
            server_default="private",
        ),
    )
    op.create_index(
        "ix_calendar_events_private_scope",
        "calendar_events",
        ["created_by", "visibility", "deleted_at"],
    )
    op.create_index(
        "ix_calendar_events_group_scope",
        "calendar_events",
        ["group_id", "visibility", "deleted_at"],
    )
    op.create_check_constraint(
        "ck_calendar_events_visibility_group",
        "calendar_events",
        "(visibility = 'private' AND group_id IS NULL) OR (visibility = 'shared' AND group_id IS NOT NULL)",
    )

    # Re-add visibility + group_id to lists
    op.execute("CREATE TYPE list_visibility AS ENUM ('private', 'shared')")
    op.drop_index("ix_lists_created_by", table_name="lists")
    op.add_column(
        "lists",
        sa.Column(
            "group_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("groups.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "lists",
        sa.Column(
            "visibility",
            sa.Enum("private", "shared", name="list_visibility"),
            nullable=False,
            server_default="private",
        ),
    )
    op.create_index(
        "ix_lists_created_by",
        "lists",
        ["created_by", "visibility", "deleted_at"],
    )
    op.create_index(
        "ix_lists_group_id",
        "lists",
        ["group_id", "visibility", "archived", "deleted_at"],
    )
    op.create_check_constraint(
        "ck_lists_visibility_group",
        "lists",
        "(visibility = 'private' AND group_id IS NULL) OR (visibility = 'shared' AND group_id IS NOT NULL)",
    )

    # Drop resource_shares
    op.drop_index("ix_resource_shares_principal", table_name="resource_shares")
    op.drop_index("ix_resource_shares_resource", table_name="resource_shares")
    op.drop_table("resource_shares")
