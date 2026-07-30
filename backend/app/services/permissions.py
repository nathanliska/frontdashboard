"""Permission helpers for the resource-shares model."""

import uuid

from fastapi import HTTPException, status

from app.models.share import PrincipalType, ResourceShare, ShareRole

# Ascending authority. Owner is deliberately absent: it is not a `ShareRole` but the *absence* of
# one (see `effective_role`), so `rank` places it above every member here.
_ROLE_RANK: dict[ShareRole, int] = {
    ShareRole.viewer: 0,
    ShareRole.editor: 1,
}


def rank(role: ShareRole | None) -> int:
    """Comparable authority, owner (None) highest.

    The single definition of "which role outranks which". It was previously written three times —
    the iteration order picking a highest share, the membership test in `can_edit`, and anywhere
    else that needed to compare — which is three chances for them to disagree when a role is added.
    """
    return len(_ROLE_RANK) if role is None else _ROLE_RANK[role]


def is_at_least(role: ShareRole | None, required: ShareRole | None) -> bool:
    """Whether `role` carries at least the authority of `required`."""
    return rank(role) >= rank(required)


def highest_role(roles: list[ShareRole]) -> ShareRole | None:
    """The strongest of some share roles, or None if there are none.

    None here means "no roles given", not owner — callers that can be the owner establish that
    before asking. Kept separate from `effective_role` because the invite path needs to know what
    someone already holds *without* the 404 that means "no access at all".
    """
    return max(roles, key=rank) if roles else None


def effective_role(
    resource_created_by: uuid.UUID,
    user_id: uuid.UUID,
    shares: list[ResourceShare],
) -> ShareRole | None:
    """Resolve a caller's role: owner is None, otherwise the highest direct share, else 404.

    Everything resolving owner/viewer/editor goes through here, child resources included — they
    reach it through their dashboard's shares.
    """
    if resource_created_by == user_id:
        return None

    matching = [ShareRole(s.role) for s in shares if s.principal_type == PrincipalType.user and s.principal_id == user_id]

    strongest = highest_role(matching)
    if strongest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return strongest


def can_read(role: ShareRole | None) -> bool:  # noqa: ARG001
    return True


def can_edit(role: ShareRole | None) -> bool:
    """True for owner and editor. Covers all content mutations."""
    return is_at_least(role, ShareRole.editor)


def can_delete(role: ShareRole | None) -> bool:
    """Owner only — deleting the resource itself."""
    return role is None


def can_manage_shares(role: ShareRole | None) -> bool:
    """Owner only — adding/removing share entries."""
    return role is None


def assert_can_edit(role: ShareRole | None) -> None:
    if not can_edit(role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Editor access required")


def assert_can_delete(role: ShareRole | None) -> None:
    if not can_delete(role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can delete")


def assert_can_manage_shares(role: ShareRole | None) -> None:
    if not can_manage_shares(role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can manage sharing")
