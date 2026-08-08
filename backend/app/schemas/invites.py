import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.share import EffectiveRole, ShareRole


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
    # The access the caller holds afterwards, not the role the link offered — reporting the link's
    # role said an owner had just been given viewer access, a grant that never happened.
    role: EffectiveRole
