import uuid

import pytest
from fastapi import HTTPException

from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole
from app.services import permissions


def _share(
    *,
    resource_type: ResourceType,
    principal_type: PrincipalType,
    principal_id: uuid.UUID,
    role: ShareRole,
) -> ResourceShare:
    return ResourceShare(
        resource_type=resource_type,
        resource_id=uuid.uuid4(),
        principal_type=principal_type,
        principal_id=principal_id,
        role=role,
        granted_by=uuid.uuid4(),
    )


def test_effective_role_returns_none_for_owner() -> None:
    user_id = uuid.uuid4()
    role = permissions.effective_role(
        user_id,
        ResourceType.list,
        user_id,
        [],
    )
    assert role is None


def test_effective_role_uses_direct_user_share() -> None:
    user_id = uuid.uuid4()
    role = permissions.effective_role(
        uuid.uuid4(),
        ResourceType.list,
        user_id,
        [
            _share(
                resource_type=ResourceType.list,
                principal_type=PrincipalType.user,
                principal_id=user_id,
                role=ShareRole.viewer,
            )
        ],
    )
    assert role == ShareRole.viewer


def test_effective_role_uses_highest_matching_role() -> None:
    user_id = uuid.uuid4()
    role = permissions.effective_role(
        uuid.uuid4(),
        ResourceType.list,
        user_id,
        [
            _share(
                resource_type=ResourceType.list,
                principal_type=PrincipalType.user,
                principal_id=user_id,
                role=ShareRole.viewer,
            ),
            _share(
                resource_type=ResourceType.list,
                principal_type=PrincipalType.user,
                principal_id=user_id,
                role=ShareRole.editor,
            ),
        ],
    )
    assert role == ShareRole.editor


def test_effective_role_raises_404_without_access() -> None:
    with pytest.raises(HTTPException) as exc:
        permissions.effective_role(
            uuid.uuid4(),
            ResourceType.calendar_event,
            uuid.uuid4(),
            [],
        )
    assert exc.value.status_code == 404


def test_role_capabilities() -> None:
    assert permissions.can_read(ShareRole.viewer)
    assert permissions.can_read(None)
    assert permissions.can_edit(ShareRole.editor)
    assert permissions.can_edit(None)
    assert not permissions.can_edit(ShareRole.viewer)
    assert permissions.can_delete(None)
    assert not permissions.can_delete(ShareRole.editor)
    assert not permissions.can_delete(ShareRole.viewer)
    assert permissions.can_manage_shares(None)
    assert not permissions.can_manage_shares(ShareRole.editor)
