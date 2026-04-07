"""move dashboard favorites to user preferences

Revision ID: r8t1v3x5z7b9
Revises: q6s8u0w2y4a6
Create Date: 2026-04-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "r8t1v3x5z7b9"
down_revision: str | Sequence[str] | None = "q6s8u0w2y4a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE users AS u
        SET preferences = jsonb_set(
            COALESCE(u.preferences, '{}'::jsonb),
            '{favorite_dashboard_ids}',
            favorites.favorite_dashboard_ids,
            true
        )
        FROM (
            SELECT
                d.user_id,
                jsonb_agg(d.id::text ORDER BY d.updated_at DESC, d.created_at DESC) AS favorite_dashboard_ids
            FROM dashboards AS d
            WHERE d.is_favorite = true
            GROUP BY d.user_id
        ) AS favorites
        WHERE u.id = favorites.user_id
        """
    )
    op.execute(
        """
        UPDATE users
        SET preferences = jsonb_set(
            COALESCE(preferences, '{}'::jsonb),
            '{favorite_dashboard_ids}',
            '[]'::jsonb,
            true
        )
        WHERE NOT (COALESCE(preferences, '{}'::jsonb) ? 'favorite_dashboard_ids')
        """
    )
    op.drop_column("dashboards", "is_favorite")


def downgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("is_favorite", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.execute(
        """
        UPDATE dashboards AS d
        SET is_favorite = true
        FROM users AS u
        WHERE d.user_id = u.id
          AND COALESCE(u.preferences->'favorite_dashboard_ids', '[]'::jsonb) ? (d.id::text)
        """
    )
