"""Upsert semantics for `create_share` (finding #19).

Granting a share that already exists is a supported operation, not an error — the route re-grants
at the new role. It used to be implemented as a SELECT followed by an INSERT, which races with
itself; these tests pin the behavior the single-statement upsert has to preserve.
"""

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.shares import ShareCreate
from app.services.shares import create_share
from tests.helpers import make_db_user


@pytest.fixture
async def target(db_session: AsyncSession) -> tuple[uuid.UUID, User, User]:
    owner = await make_db_user(db_session, label="owner")
    recipient = await make_db_user(db_session, label="recipient")
    return uuid.uuid4(), owner, recipient


async def _grant(db: AsyncSession, resource_id: uuid.UUID, recipient: User, owner: User, role: ShareRole) -> ResourceShare:
    return await create_share(
        ResourceType.dashboard,
        resource_id,
        ShareCreate(principal_type=PrincipalType.user, principal_id=recipient.id, role=role),
        owner.id,
        db,
    )


async def test_first_grant_creates_the_row(db_session: AsyncSession, target: tuple[uuid.UUID, User, User]) -> None:
    resource_id, owner, recipient = target

    share = await _grant(db_session, resource_id, recipient, owner, ShareRole.viewer)

    assert share.id is not None
    assert share.role == ShareRole.viewer
    assert share.granted_by == owner.id
    assert share.created_at is not None


async def test_re_granting_updates_the_role_in_place(db_session: AsyncSession, target: tuple[uuid.UUID, User, User]) -> None:
    resource_id, owner, recipient = target
    first = await _grant(db_session, resource_id, recipient, owner, ShareRole.viewer)
    original_id = first.id

    second = await _grant(db_session, resource_id, recipient, owner, ShareRole.editor)

    assert second.id == original_id, "a re-grant must update the existing row, not create a second"
    assert second.role == ShareRole.editor

    # The identity map must not still be serving the pre-upsert role.
    assert first.role == ShareRole.editor

    count = await db_session.scalar(
        select(func.count())
        .select_from(ResourceShare)
        .where(
            ResourceShare.resource_type == ResourceType.dashboard,
            ResourceShare.resource_id == resource_id,
            ResourceShare.principal_id == recipient.id,
        )
    )
    assert count == 1


async def test_re_granting_preserves_the_original_grant_provenance(db_session: AsyncSession, target: tuple[uuid.UUID, User, User]) -> None:
    """Only the role is upserted — who granted it first, and when, is history."""
    resource_id, owner, recipient = target
    other_editor = await make_db_user(db_session, label="other-editor")
    first = await _grant(db_session, resource_id, recipient, owner, ShareRole.viewer)
    granted_at = first.created_at

    second = await _grant(db_session, resource_id, recipient, other_editor, ShareRole.editor)

    assert second.granted_by == owner.id
    assert second.created_at == granted_at


async def test_grants_to_different_principals_stay_separate(db_session: AsyncSession, target: tuple[uuid.UUID, User, User]) -> None:
    resource_id, owner, recipient = target
    second_recipient = await make_db_user(db_session, label="second-recipient")

    first = await _grant(db_session, resource_id, recipient, owner, ShareRole.viewer)
    second = await _grant(db_session, resource_id, second_recipient, owner, ShareRole.editor)

    assert first.id != second.id
    assert first.role == ShareRole.viewer
