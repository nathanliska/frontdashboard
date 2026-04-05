import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.schemas.shares import ShareCreate


class WidgetResponse(BaseModel):
    id: uuid.UUID
    dashboard_id: uuid.UUID
    widget_type: str
    widget_version: int
    config: dict[str, Any]
    resource_type: str | None
    resource_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DashboardSummary(BaseModel):
    """Lightweight dashboard info for the listing page (no widgets/layout)."""

    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    access_description: str | None = None
    is_shared: bool = False
    is_favorite: bool
    version: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DashboardResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    is_shared: bool
    is_favorite: bool
    layout: list[dict[str, Any]]
    version: int
    widgets: list[WidgetResponse]

    model_config = ConfigDict(from_attributes=True)


class DashboardCreate(BaseModel):
    name: str
    shares: list[ShareCreate] = []


class DashboardUpdate(BaseModel):
    name: str | None = None
    is_favorite: bool | None = None


class LayoutUpdate(BaseModel):
    layout: list[dict[str, Any]]
    version: int


class WidgetCreate(BaseModel):
    widget_type: str
    config: dict[str, Any] = {}
    resource_type: str | None = None
    resource_id: uuid.UUID | None = None


class WidgetConfigUpdate(BaseModel):
    config: dict[str, Any]
