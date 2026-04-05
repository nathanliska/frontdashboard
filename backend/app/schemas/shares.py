import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.share import PrincipalType, ShareRole


class ShareCreate(BaseModel):
    principal_type: PrincipalType
    principal_id: uuid.UUID
    role: ShareRole


class ShareUpdate(BaseModel):
    role: ShareRole


class ShareResponse(BaseModel):
    id: uuid.UUID
    resource_type: str
    resource_id: uuid.UUID
    principal_type: PrincipalType
    principal_id: uuid.UUID
    principal_name: str  # resolved: user.display_name or group.name
    role: ShareRole
    granted_by: uuid.UUID
    created_at: datetime


class InheritedDashboardAccessResponse(BaseModel):
    dashboard_id: uuid.UUID
    dashboard_name: str


class ResourceAccessResponse(BaseModel):
    direct_shares: list[ShareResponse]
    inherited_dashboards: list[InheritedDashboardAccessResponse] = []
