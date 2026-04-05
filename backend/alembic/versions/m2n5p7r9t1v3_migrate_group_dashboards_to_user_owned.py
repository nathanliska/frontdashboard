"""migrate legacy group dashboards to user-owned shared dashboards

Revision ID: m2n5p7r9t1v3
Revises: l9m2n4p6q8r0
Create Date: 2026-04-02

This is a one-time data migration that converts legacy dashboards with
`group_id` ownership into user-owned dashboards plus an equivalent
group share.

Ownership assignment priority:
1. Earliest active group owner
2. Earliest active group member (owner/admin/member precedence)
3. Group.created_by

The migrated dashboard keeps the same ID. The original group receives a
`viewer` share, which preserves existing access because dashboard group
admins/owners are elevated to implicit `manager` by the permission layer.
"""

from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa

revision: str = "m2n5p7r9t1v3"
down_revision: str | None = "l9m2n4p6q8r0"
branch_labels = None
depends_on = None


LEGACY_DASHBOARDS_QUERY = sa.text(
    """
    SELECT
        d.id AS dashboard_id,
        d.group_id AS group_id,
        COALESCE(
            owner_member.user_id,
            fallback_member.user_id,
            g.created_by
        ) AS owner_user_id
    FROM dashboards AS d
    JOIN groups AS g
        ON g.id = d.group_id
    LEFT JOIN LATERAL (
        SELECT gm.user_id
        FROM group_members AS gm
        WHERE gm.group_id = d.group_id
          AND gm.left_at IS NULL
          AND gm.role = 'owner'
        ORDER BY gm.joined_at ASC
        LIMIT 1
    ) AS owner_member ON TRUE
    LEFT JOIN LATERAL (
        SELECT gm.user_id
        FROM group_members AS gm
        WHERE gm.group_id = d.group_id
          AND gm.left_at IS NULL
        ORDER BY
            CASE gm.role
                WHEN 'owner' THEN 0
                WHEN 'admin' THEN 1
                ELSE 2
            END,
            gm.joined_at ASC
        LIMIT 1
    ) AS fallback_member ON TRUE
    WHERE d.group_id IS NOT NULL
    """
)


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(LEGACY_DASHBOARDS_QUERY).mappings().all()
    if not rows:
        return

    for row in rows:
        dashboard_id = row["dashboard_id"]
        group_id = row["group_id"]
        owner_user_id = row["owner_user_id"]

        if owner_user_id is None:
            raise RuntimeError(
                f"Could not determine an owner for legacy group dashboard {dashboard_id}"
            )

        bind.execute(
            sa.text(
                """
                UPDATE dashboards
                SET user_id = :owner_user_id,
                    group_id = NULL
                WHERE id = :dashboard_id
                """
            ),
            {
                "dashboard_id": dashboard_id,
                "owner_user_id": owner_user_id,
            },
        )

        bind.execute(
            sa.text(
                """
                INSERT INTO resource_shares (
                    id,
                    resource_type,
                    resource_id,
                    principal_type,
                    principal_id,
                    role,
                    granted_by
                )
                VALUES (
                    :id,
                    'dashboard',
                    :dashboard_id,
                    'group',
                    :group_id,
                    'viewer',
                    :granted_by
                )
                ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
                DO NOTHING
                """
            ),
            {
                "id": uuid.uuid4(),
                "dashboard_id": dashboard_id,
                "group_id": group_id,
                "granted_by": owner_user_id,
            },
        )


def downgrade() -> None:
    # This data migration is intentionally one-way.
    # Reconstructing which share-based dashboards were originally group-owned
    # is not reliable once the application continues running.
    pass
