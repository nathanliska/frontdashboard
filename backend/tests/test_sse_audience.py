"""Who receives an SSE event about a dashboard (`shares.dashboard_audience_user_ids`).

Untested until 2026-07-29, and the gap was invisible: narrowing the audience to the owner alone
left the entire suite green. That is the worst shape a bug can take here, because the failure is
silent — a shared user's tab simply stops updating and shows stale data with nothing to indicate
it (backend/CLAUDE.md). Lists and calendar events inherit this audience, so a miss here goes stale
across all three resource types at once.
"""

import uuid
from typing import cast

from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.services.shares import dashboard_audience_user_ids
from tests.helpers import make_db_dashboard, make_db_user


def _share(dashboard_id: uuid.UUID, principal_id: uuid.UUID, granted_by: uuid.UUID, *, principal_type=PrincipalType.user) -> ResourceShare:
    return ResourceShare(
        resource_type=ResourceType.dashboard,
        resource_id=dashboard_id,
        principal_type=principal_type,
        principal_id=principal_id,
        role=ShareRole.viewer,
        granted_by=granted_by,
    )


async def test_the_owner_is_always_in_the_audience(db_session) -> None:
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)

    assert dashboard_audience_user_ids(dashboard, []) == {owner.id}


async def test_shared_users_are_in_the_audience(db_session) -> None:
    """The property with no coverage before: a viewer must receive the event, or their open tab
    keeps rendering data the owner has already changed."""
    owner = await make_db_user(db_session, label="owner")
    viewer = await make_db_user(db_session, label="viewer")
    editor = await make_db_user(db_session, label="editor")
    dashboard = await make_db_dashboard(db_session, owner)

    shares = [_share(dashboard.id, viewer.id, owner.id), _share(dashboard.id, editor.id, owner.id)]

    assert dashboard_audience_user_ids(dashboard, shares) == {owner.id, viewer.id, editor.id}


async def test_a_non_user_principal_is_not_addressed_as_a_user(db_session) -> None:
    """`principal_id` only names a user when `principal_type` says so. A CHECK constraint pins the
    column to `'user'` today, so this cannot arise through the API — it pins the filter that two of
    the three copies of this helper had already lost before they were unified."""
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)

    stray = _share(dashboard.id, uuid.uuid4(), owner.id)
    stray.principal_type = cast("PrincipalType", "group")  # unreachable via the API; the constraint forbids it

    assert dashboard_audience_user_ids(dashboard, [stray]) == {owner.id}
