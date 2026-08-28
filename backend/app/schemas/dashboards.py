import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, field_validator

from app.schemas.common import PatchModel

DASHBOARD_NAME_MAX_LENGTH = 100
DashboardName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=DASHBOARD_NAME_MAX_LENGTH),
]

# The canonical grid every persisted layout counts in (ADR-009). Both axes are hard bounds: a board
# is one screen. Changing either is a migration, since a coordinate is meaningless without its basis.
GRID_COLUMNS = 24
GRID_ROWS = 24


class LayoutItem(BaseModel):
    """One react-grid-layout entry. These five keys ARE the layout state.

    react-grid-layout round-trips transient bookkeeping (`moved`, `static`, `minW`, …) through
    its change events; none of it is ours to persist — the library re-derives it every render —
    so unknown keys are dropped (default `extra="ignore"`) on write and on read-back of rows that
    stored them historically.

    Deliberately types-only: range bounds live on `LayoutUpdate`, the write path, so a
    historically persisted out-of-range value degrades to an odd-looking grid instead of failing
    response validation and turning every read of that dashboard into a 500 (same reasoning as
    `CalendarWidgetConfig.view`).
    """

    i: str
    x: int
    y: int
    w: int
    h: int


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
    access_description: str | None = None
    is_shared: bool = False
    can_edit: bool
    can_manage_shares: bool
    is_favorite: bool
    version: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TrashedDashboardSummary(BaseModel):
    """A dashboard in the owner's trash (finding #40): enough to recognise it and restore it."""

    id: uuid.UUID
    name: str
    deleted_at: datetime
    purge_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DashboardResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    is_shared: bool
    can_edit: bool
    can_manage_shares: bool
    is_favorite: bool
    layout: list[LayoutItem]
    version: int
    widgets: list[WidgetResponse]

    model_config = ConfigDict(from_attributes=True)


class LayoutGesture(BaseModel):
    """The widget a person moved or resized, as the client alone can report it."""

    widget_id: uuid.UUID
    action: Literal["moved", "resized"]

    model_config = ConfigDict(extra="forbid")


class DashboardCreate(BaseModel):
    name: DashboardName

    model_config = ConfigDict(extra="forbid")


class DashboardUpdate(PatchModel):
    name: DashboardName | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("name", mode="before")
    @classmethod
    def _reject_null_updates(cls, value: object) -> object:
        if value is None:
            raise ValueError("Dashboard update fields cannot be null")
        return value


class LayoutUpdate(BaseModel):
    layout: list[LayoutItem]
    version: int
    # What the reader wanted to know and the layout cannot say. Compaction reflows neighbours, so
    # diffing two layouts names every widget that shifted rather than the one that was grabbed.
    # Absent on the writes no one gestured — fitting a new widget, the mobile projection.
    gesture: LayoutGesture | None = None

    @field_validator("layout")
    @classmethod
    def _reject_impossible_grids(cls, layout: list[LayoutItem]) -> list[LayoutItem]:
        """Bounds live here, on the write path, so reads of legacy rows can't 500 (see LayoutItem).

        Fitting the canonical grid is the invariant behind #53: an item past its edge is
        definitionally not a layout in that grid, and react-grid-layout would resolve it by
        clamping — the exact remap-then-persist trap the client guards against. Both axes are
        bounded, because a board is one screen and a widget outside it cannot be reached.

        Overlap is rejected for a harder reason than tidiness: a client whose compactor declines to
        settle an arrangement reports one where widgets still sit on each other, and every
        coordinate in it is individually in range. Accepting that stores a layout no client can
        render back, which is a corruption a client-side check cannot be trusted to prevent.
        """
        seen: set[str] = set()
        placed: list[LayoutItem] = []
        for item in layout:
            if item.x < 0 or item.y < 0 or item.w < 1 or item.h < 1:
                raise ValueError(f"Layout item {item.i!r} has out-of-range coordinates")
            if item.x + item.w > GRID_COLUMNS or item.y + item.h > GRID_ROWS:
                raise ValueError(f"Layout item {item.i!r} does not fit a {GRID_COLUMNS}x{GRID_ROWS} grid")
            if item.i in seen:
                raise ValueError(f"Duplicate layout item {item.i!r}")
            for other in placed:
                if item.x < other.x + other.w and other.x < item.x + item.w and item.y < other.y + other.h and other.y < item.y + item.h:
                    raise ValueError(f"Layout items {other.i!r} and {item.i!r} overlap")
            seen.add(item.i)
            placed.append(item)
        return layout


class _WidgetCreateBase(BaseModel):
    # Forbid, unlike the configs: an unknown top-level field is a caller error (the misspelled
    # `resource_id` on a clock widget should 422, not silently create an unbound widget).
    model_config = ConfigDict(extra="forbid")


class ClockWidgetCreate(_WidgetCreateBase):
    widget_type: Literal["clock"]
    config: ClockWidgetConfig = Field(default_factory=ClockWidgetConfig)


class CalendarWidgetCreate(_WidgetCreateBase):
    widget_type: Literal["calendar"]
    config: CalendarWidgetConfig = Field(default_factory=CalendarWidgetConfig)


class AgendaWidgetCreate(_WidgetCreateBase):
    widget_type: Literal["agenda"]
    config: AgendaWidgetConfig = Field(default_factory=AgendaWidgetConfig)


class ListWidgetCreateConfig(BaseModel):
    """Create-time list widget config: `name` seeds a new list, `list_name` caches a bound one."""

    name: str | None = None
    list_name: str | None = None
    list_type: str | None = None

    model_config = ConfigDict(extra="allow")


class ListWidgetCreate(_WidgetCreateBase):
    widget_type: Literal["list"]
    config: ListWidgetCreateConfig = Field(default_factory=ListWidgetCreateConfig)
    resource_type: Literal["list"] | None = None
    resource_id: uuid.UUID | None = None


# Mirrors the response union: `widget_type` discriminates, and each variant carries its own typed
# config — so "clock widgets cannot bind a resource" and "unknown widget type" are schema facts
# (422 at the boundary) rather than router checks (finding #14).
WidgetCreate = Annotated[
    ClockWidgetCreate | CalendarWidgetCreate | ListWidgetCreate | AgendaWidgetCreate,
    Field(discriminator="widget_type"),
]

# What PATCH /widgets/{id} must validate a new config against, per widget type. The request body
# can't discriminate itself (the widget's type lives on the row, not in the payload), so the
# router looks the model up here. Without this, a stored `{"timezone": 123}` passes the write and
# then fails response validation — turning every later read of the dashboard into a 500.
WIDGET_CONFIG_MODELS: dict[str, type[BaseModel]] = {
    "clock": ClockWidgetConfig,
    "calendar": CalendarWidgetConfig,
    "list": ListWidgetConfig,
    "agenda": AgendaWidgetConfig,
}


class WidgetConfigUpdate(BaseModel):
    config: dict[str, Any]
