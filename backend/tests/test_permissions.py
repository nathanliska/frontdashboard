import uuid
from typing import get_args

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ResourceType, ShareRole, as_share_role
from app.schemas.shares import ShareCreate
from app.services import permissions

_STORABLE = get_args(ShareRole.__value__)


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


def test_the_storable_subset_excludes_exactly_owner() -> None:
    """`ShareRole` is derived from `EffectiveRole`; this pins what the derivation must exclude."""
    assert set(_STORABLE) == {EffectiveRole.viewer, EffectiveRole.editor}


def test_owner_is_rejected_at_the_input_boundary() -> None:
    """The security property the split type exists for: a client cannot request `owner`."""
    with pytest.raises(ValidationError):
        ShareCreate.model_validate({"principal_type": "user", "principal_id": str(uuid.uuid4()), "role": "owner"})
    with pytest.raises(ValueError, match="never stored"):
        as_share_role("owner")


def test_effective_role_returns_owner_for_the_creator() -> None:
    user_id = uuid.uuid4()
    role = permissions.effective_role(user_id, user_id, [])
    assert role is EffectiveRole.owner


def test_effective_role_uses_direct_user_share() -> None:
    user_id = uuid.uuid4()
    role = permissions.effective_role(
        uuid.uuid4(),
        user_id,
        [
            _share(
                resource_type=ResourceType.list,
                principal_type=PrincipalType.user,
                principal_id=user_id,
                role=EffectiveRole.viewer,
            )
        ],
    )
    assert role is EffectiveRole.viewer


def test_effective_role_uses_highest_matching_role() -> None:
    user_id = uuid.uuid4()
    role = permissions.effective_role(
        uuid.uuid4(),
        user_id,
        [
            _share(
                resource_type=ResourceType.list,
                principal_type=PrincipalType.user,
                principal_id=user_id,
                role=EffectiveRole.viewer,
            ),
            _share(
                resource_type=ResourceType.list,
                principal_type=PrincipalType.user,
                principal_id=user_id,
                role=EffectiveRole.editor,
            ),
        ],
    )
    assert role is EffectiveRole.editor


def test_effective_role_raises_404_without_access() -> None:
    with pytest.raises(HTTPException) as exc:
        permissions.effective_role(uuid.uuid4(), uuid.uuid4(), [])
    assert exc.value.status_code == 404


def test_every_role_has_a_distinct_rank() -> None:
    """A member missing from the rank table would KeyError here on its first comparison."""
    ranks = [permissions.rank(role) for role in EffectiveRole]
    assert len(set(ranks)) == len(EffectiveRole)


def test_owner_outranks_every_storable_role() -> None:
    for role in _STORABLE:
        assert permissions.is_at_least(EffectiveRole.owner, role)
        assert not permissions.is_at_least(role, EffectiveRole.owner)


def test_role_capabilities() -> None:
    assert permissions.can_read(EffectiveRole.viewer)
    assert permissions.can_read(EffectiveRole.owner)
    assert permissions.can_edit(EffectiveRole.editor)
    assert permissions.can_edit(EffectiveRole.owner)
    assert not permissions.can_edit(EffectiveRole.viewer)
    assert permissions.can_delete(EffectiveRole.owner)
    assert not permissions.can_delete(EffectiveRole.editor)
    assert not permissions.can_delete(EffectiveRole.viewer)
    assert permissions.can_manage_shares(EffectiveRole.owner)
    assert not permissions.can_manage_shares(EffectiveRole.editor)
    assert not permissions.can_manage_shares(EffectiveRole.viewer)
