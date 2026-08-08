"""Permission helpers for the resource-shares model."""

import uuid

from fastapi import HTTPException, status

from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ShareRole, as_share_role

# Ascending authority. Owner sits above every storable role because it is the creator, which no
# share row can grant. A stored `ShareRole` is a member of `EffectiveRole`, so both rank directly.
_ROLE_RANK: dict[EffectiveRole, int] = {
    EffectiveRole.viewer: 0,
    EffectiveRole.editor: 1,
    EffectiveRole.owner: 2,
}


def rank(role: EffectiveRole) -> int:
    """Comparable authority, owner highest — the single definition of which role outranks which."""
    return _ROLE_RANK[role]


def is_at_least(role: EffectiveRole, required: EffectiveRole) -> bool:
    """Whether `role` carries at least the authority of `required`."""
    return rank(role) >= rank(required)


def highest_role(roles: list[ShareRole]) -> ShareRole | None:
    """The strongest of some share roles, or None if there are none.

    None here means "no roles given" — it never means owner, which `effective_role` returns as a
    value. Kept separate from that because the invite path needs to know what someone already
    holds *without* the 404 that means "no access at all".
    """
    return max(roles, key=rank) if roles else None


def effective_role(
    resource_created_by: uuid.UUID,
    user_id: uuid.UUID,
    shares: list[ResourceShare],
) -> EffectiveRole:
    """Resolve a caller's role: owner for the creator, otherwise the highest direct share, else 404.

    Everything resolving owner/viewer/editor goes through here, child resources included — they
    reach it through their dashboard's shares.
    """
    if resource_created_by == user_id:
        return EffectiveRole.owner

    matching = [as_share_role(s.role) for s in shares if s.principal_type == PrincipalType.user and s.principal_id == user_id]

    strongest = highest_role(matching)
    if strongest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return strongest


def can_read(role: EffectiveRole) -> bool:  # noqa: ARG001
    return True


def can_edit(role: EffectiveRole) -> bool:
    """True for owner and editor. Covers all content mutations."""
    return is_at_least(role, EffectiveRole.editor)


def can_delete(role: EffectiveRole) -> bool:
    """Owner only — deleting the resource itself."""
    return role is EffectiveRole.owner


def can_manage_shares(role: EffectiveRole) -> bool:
    """Owner only — adding/removing share entries."""
    return role is EffectiveRole.owner


def assert_can_edit(role: EffectiveRole) -> None:
    if not can_edit(role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Editor access required")


def assert_can_delete(role: EffectiveRole) -> None:
    if not can_delete(role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can delete")


def assert_can_manage_shares(role: EffectiveRole) -> None:
    if not can_manage_shares(role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can manage sharing")
