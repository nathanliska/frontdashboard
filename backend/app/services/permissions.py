"""Permission helpers for the resource-shares model."""

import uuid

from fastapi import HTTPException, status

from app.models.share import PrincipalType, ResourceShare, ResourceType, ShareRole


def effective_role(
    resource_created_by: uuid.UUID,
    resource_type: ResourceType,  # noqa: ARG001
    user_id: uuid.UUID,
    shares: list[ResourceShare],
) -> ShareRole | None:
    """Compute the caller's role for a resource."""
    if resource_created_by == user_id:
        return None

    matching = [s for s in shares if s.principal_type == PrincipalType.user and s.principal_id == user_id]

    if not matching:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    for r in (ShareRole.editor, ShareRole.viewer):
        if any(s.role == r for s in matching):
            return r

    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")  # pragma: no cover


def can_read(role: ShareRole | None) -> bool:  # noqa: ARG001
    return True


def can_edit(role: ShareRole | None) -> bool:
    """True for owner and editor. Covers all content mutations."""
    return role in (None, ShareRole.editor)


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
