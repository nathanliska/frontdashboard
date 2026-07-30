import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.share import ShareRole


class InviteCreate(BaseModel):
    role: ShareRole

    model_config = ConfigDict(extra="forbid")


class InviteResponse(BaseModel):
    """A live invite as shown in the share panel. Never carries the code."""

    id: uuid.UUID
    role: ShareRole
    expires_at: datetime
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class InviteCreatedResponse(InviteResponse):
    """Returned once, at creation. `code` is unrecoverable afterwards — only its hash is stored."""

    code: str


class InvitePreviewResponse(BaseModel):
    """What an unauthenticated caller sees before redeeming.

    Deliberately minimal: enough to decide whether to accept, nothing more. Holding the code is
    what grants this.
    """

    dashboard_name: str
    invited_by: str
    role: ShareRole


class InviteAcceptResponse(BaseModel):
    dashboard_id: uuid.UUID
    dashboard_name: str
    # `None` means owner, the same as `permissions.effective_role` — an owner holds no share row,
    # so there is no role to report. Reporting the *link's* role instead said an owner had just
    # been given viewer access, which is both untrue and contradicted by the grant never happening.
    role: ShareRole | None
