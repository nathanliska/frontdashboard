import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, field_validator

from app.schemas.common import PatchModel
from app.schemas.shares import ShareCreate

DASHBOARD_NAME_MAX_LENGTH = 100
DashboardName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=DASHBOARD_NAME_MAX_LENGTH),
]


class _WidgetResponseBase(BaseModel):
    id: uuid.UUID
    dashboard_id: uuid.UUID
    widget_version: int
    resource_type: str | None
    resource_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ClockWidgetConfig(BaseModel):
    timezone: str | None = None

    model_config = ConfigDict(extra="allow")


class ClockWidgetResponse(_WidgetResponseBase):
    widget_type: Literal["clock"]
    config: ClockWidgetConfig


class CalendarWidgetConfig(BaseModel):
    # `view` is intentionally `str`, not a Literal: it is read back from persisted
    # data, and a stored value outside a fixed set would otherwise 500 on read.
    view: str | None = None

    model_config = ConfigDict(extra="allow")


class CalendarWidgetResponse(_WidgetResponseBase):
    widget_type: Literal["calendar"]
    config: CalendarWidgetConfig


class ListWidgetConfig(BaseModel):
    list_name: str | None = None
    list_type: str | None = None

    model_config = ConfigDict(extra="allow")


class ListWidgetResponse(_WidgetResponseBase):
    widget_type: Literal["list"]
    config: ListWidgetConfig


class AgendaWidgetConfig(BaseModel):
    model_config = ConfigDict(extra="allow")


class AgendaWidgetResponse(_WidgetResponseBase):
    widget_type: Literal["agenda"]
    config: AgendaWidgetConfig


WidgetResponse = Annotated[
    ClockWidgetResponse | CalendarWidgetResponse | ListWidgetResponse | AgendaWidgetResponse,
    Field(discriminator="widget_type"),
]

# `WidgetResponse` is a type alias (Annotated discriminated union), not a BaseModel
# subclass, so it has no `.model_validate()`. Router code that needs to validate an
# ORM `DashboardWidget` into this union uses this adapter instead.
WidgetResponseAdapter: TypeAdapter[Any] = TypeAdapter(WidgetResponse)


class DashboardSummary(BaseModel):
    """Lightweight dashboard info for the listing page (no widgets/layout)."""

    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    archived: bool
    access_description: str | None = None
    is_shared: bool = False
    can_edit: bool
    can_manage_shares: bool
    is_favorite: bool
    version: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DashboardResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    archived: bool
    is_shared: bool
    can_edit: bool
    can_manage_shares: bool
    is_favorite: bool
    layout: list[dict[str, Any]]
    version: int
    widgets: list[WidgetResponse]

    model_config = ConfigDict(from_attributes=True)


class DashboardCreate(BaseModel):
    name: DashboardName
    shares: list[ShareCreate] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")

    @field_validator("shares")
    @classmethod
    def _reject_duplicate_share_targets(cls, shares: list[ShareCreate]) -> list[ShareCreate]:
        targets = {(share.principal_type, share.principal_id) for share in shares}
        if len(targets) != len(shares):
            raise ValueError("Duplicate share targets are not allowed")
        return shares


class DashboardUpdate(PatchModel):
    name: DashboardName | None = None
    archived: bool | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("name", "archived", mode="before")
    @classmethod
    def _reject_null_updates(cls, value: object) -> object:
        if value is None:
            raise ValueError("Dashboard update fields cannot be null")
        return value


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
