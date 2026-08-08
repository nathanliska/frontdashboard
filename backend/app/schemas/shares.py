import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.share import EffectiveRole, PrincipalType, ShareRole


class ShareCreate(BaseModel):
    principal_type: PrincipalType
    principal_id: uuid.UUID
    role: ShareRole


class ShareUpdate(BaseModel):
    role: ShareRole


class DashboardMemberResponse(BaseModel):
    """One person with access to a dashboard, owner included — a picker row, not a grant."""

    user_id: uuid.UUID
    display_name: str
    role: EffectiveRole


class ShareResponse(BaseModel):
    id: uuid.UUID
    resource_type: str
    resource_id: uuid.UUID
    principal_type: PrincipalType
    principal_id: uuid.UUID
    principal_name: str  # resolved: user.display_name
    role: ShareRole
    granted_by: uuid.UUID
    created_at: datetime


class InheritedDashboardAccessResponse(BaseModel):
    dashboard_id: uuid.UUID
    dashboard_name: str


class ResourceAccessResponse(BaseModel):
    direct_shares: list[ShareResponse]
    inherited_dashboards: list[InheritedDashboardAccessResponse] = []
