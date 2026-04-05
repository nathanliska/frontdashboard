"""add_lists

Revision ID: c1d4f2b8e6a3
Revises: b7c3e1a9d5f2
Create Date: 2026-03-29 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c1d4f2b8e6a3"
down_revision: str | None = "b7c3e1a9d5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

list_type_enum = sa.Enum("checklist", "grocery", "todo", name="list_type")
visibility_enum = sa.Enum("private", "shared", name="visibility")
item_priority_enum = sa.Enum("low", "medium", "high", name="item_priority")


def upgrade() -> None:
    op.create_table(
        "lists",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("groups.id"), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("list_type", list_type_enum, nullable=False),
        sa.Column("visibility", visibility_enum, nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(visibility = 'private' AND group_id IS NULL) OR (visibility = 'shared' AND group_id IS NOT NULL)",
            name="ck_lists_visibility_group",
        ),
    )
    op.create_index("ix_lists_created_by", "lists", ["created_by", "visibility", "deleted_at"])
    op.create_index("ix_lists_group_id", "lists", ["group_id", "visibility", "archived", "deleted_at"])

    op.create_table(
        "list_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("list_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("lists.id"), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("checked", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("priority", item_priority_enum, nullable=True),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("assigned_to", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_list_items_list_id", "list_items", ["list_id", "sort_order", "deleted_at"])
    op.create_index("ix_list_items_assigned_to", "list_items", ["assigned_to", "checked", "deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_list_items_assigned_to", table_name="list_items")
    op.drop_index("ix_list_items_list_id", table_name="list_items")
    op.drop_table("list_items")
    op.drop_index("ix_lists_group_id", table_name="lists")
    op.drop_index("ix_lists_created_by", table_name="lists")
    op.drop_table("lists")
    item_priority_enum.drop(op.get_bind())
    visibility_enum.drop(op.get_bind())
    list_type_enum.drop(op.get_bind())
