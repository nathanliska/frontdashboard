"""Unit tests for the widget response discriminated union (finding #23, slice 1).

No DB fixtures are used here, so these are auto-marked `unit` and run under
`pytest -m unit` with no Docker/Postgres required.
"""

import uuid
from datetime import UTC, datetime

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.dashboards import (
    GRID_COLUMNS,
    AgendaWidgetResponse,
    CalendarWidgetResponse,
    ClockWidgetResponse,
    LayoutUpdate,
    ListWidgetCreate,
    ListWidgetResponse,
    WidgetCreate,
    WidgetResponse,
)

adapter: TypeAdapter[WidgetResponse] = TypeAdapter(WidgetResponse)


def _base_fields() -> dict:
    now = datetime.now(UTC)
    return {
        "id": uuid.uuid4(),
        "dashboard_id": uuid.uuid4(),
        "widget_version": 1,
        "resource_type": None,
        "resource_id": None,
        "created_at": now,
        "updated_at": now,
    }


def test_clock_widget_validates_and_round_trips_extra_config_keys() -> None:
    payload = {
        **_base_fields(),
        "widget_type": "clock",
        "config": {"timezone": "UTC", "extra": "x"},
    }
    result = adapter.validate_python(payload)
    assert isinstance(result, ClockWidgetResponse)
    dumped = result.model_dump()
    assert dumped["config"]["timezone"] == "UTC"
    # Extra keys beyond the typed fields must survive (frontend spreads {...config}
    # back on update; dropping them would silently lose data).
    assert dumped["config"]["extra"] == "x"


def test_calendar_widget_accepts_known_view_value() -> None:
    payload = {
        **_base_fields(),
        "widget_type": "calendar",
        "config": {"view": "week"},
    }
    result = adapter.validate_python(payload)
    assert isinstance(result, CalendarWidgetResponse)
    assert result.config.view == "week"


def test_calendar_widget_accepts_out_of_set_view_value_without_500() -> None:
    """`view` must be `str`, not a `Literal`.

    A stored value outside a fixed set would otherwise 500 on read instead of being un-narrowed.
    """
    payload = {
        **_base_fields(),
        "widget_type": "calendar",
        "config": {"view": "weird"},
    }
    result = adapter.validate_python(payload)
    assert isinstance(result, CalendarWidgetResponse)
    assert result.config.view == "weird"


def test_list_widget_validates_with_list_name_and_list_type() -> None:
    payload = {
        **_base_fields(),
        "widget_type": "list",
        "config": {"list_name": "Groceries", "list_type": "checklist"},
    }
    result = adapter.validate_python(payload)
    assert isinstance(result, ListWidgetResponse)
    assert result.config.list_name == "Groceries"
    assert result.config.list_type == "checklist"


def test_agenda_widget_validates_with_empty_config() -> None:
    payload = {
        **_base_fields(),
        "widget_type": "agenda",
        "config": {},
    }
    result = adapter.validate_python(payload)
    assert isinstance(result, AgendaWidgetResponse)


def test_unknown_widget_type_raises_validation_error() -> None:
    """The widget_type union is a closed set.

    It has no fallback variant, so an unknown stored type is a hard validation error rather than
    being silently accepted.
    """
    payload = {
        **_base_fields(),
        "widget_type": "unknown",
        "config": {},
    }
    with pytest.raises(ValidationError):
        adapter.validate_python(payload)


# ── Create / layout write-side schema facts (finding #14) ────────────────────────────────────────

create_adapter: TypeAdapter[WidgetCreate] = TypeAdapter(WidgetCreate)


def test_widget_create_rejects_unknown_type_at_the_schema() -> None:
    with pytest.raises(ValidationError):
        create_adapter.validate_python({"widget_type": "unknown"})


def test_only_the_list_variant_can_carry_resource_fields() -> None:
    """Only the list variant may carry resource fields — a schema fact, not a router check."""
    with pytest.raises(ValidationError):
        create_adapter.validate_python({"widget_type": "clock", "resource_id": str(uuid.uuid4())})
    bound = create_adapter.validate_python({"widget_type": "list", "resource_type": "list", "resource_id": str(uuid.uuid4())})
    assert isinstance(bound, ListWidgetCreate)


def test_widget_create_config_is_typed_per_variant() -> None:
    """A mistyped known key 422s at the boundary instead of poisoning reads after storage."""
    with pytest.raises(ValidationError):
        create_adapter.validate_python({"widget_type": "clock", "config": {"timezone": 123}})
    created = create_adapter.validate_python({"widget_type": "clock", "config": {"timezone": "UTC", "title": "x"}})
    # Extras still round-trip: config models stay extra="allow".
    assert created.config.model_dump(exclude_unset=True) == {"timezone": "UTC", "title": "x"}


def test_layout_update_bounds_the_canonical_grid() -> None:
    """Write-side bounds only — LayoutItem itself stays types-only so reads can't 500 (#53/ADR-009)."""
    # Derived from the basis, and flush against its right edge: the pair the comparison actually
    # turns on. A literal here sits in the interior the moment the grid widens, so it would keep
    # passing while testing nothing — which is how widening it to 24 first went unnoticed.
    fits = {"i": "a", "x": GRID_COLUMNS - 4, "y": 0, "w": 4, "h": 3}
    assert LayoutUpdate(layout=[fits], version=0).layout[0].w == 4

    for bad in (
        {**fits, "x": GRID_COLUMNS - 3},  # one column past the edge
        {**fits, "x": -1},
        {**fits, "w": 0},
        {**fits, "h": 0},
    ):
        with pytest.raises(ValidationError):
            LayoutUpdate(layout=[bad], version=0)

    with pytest.raises(ValidationError):
        LayoutUpdate(layout=[fits, dict(fits)], version=0)  # duplicate item id


def test_layout_update_rejects_overlapping_items() -> None:
    """Every coordinate in range, and still not a layout any client could render back."""
    # The shape a refused settlement produces: the client's compactor declined to move these apart,
    # so they are reported still sitting on each other. A bounds check passes it, and accepting it
    # stored two widgets in the same cells.
    overlapping = [
        {"i": "a", "x": 0, "y": 1, "w": 3, "h": 5},
        {"i": "b", "x": 2, "y": 0, "w": 21, "h": 20},
    ]

    with pytest.raises(ValidationError):
        LayoutUpdate(layout=overlapping, version=0)

    # Touching edges are not overlapping — the boundary this rule turns on.
    flush = [
        {"i": "a", "x": 0, "y": 0, "w": 3, "h": 5},
        {"i": "b", "x": 3, "y": 0, "w": 21, "h": 20},
        {"i": "c", "x": 0, "y": 5, "w": 3, "h": 5},
    ]

    assert len(LayoutUpdate(layout=flush, version=0).layout) == 3


def test_layout_items_drop_transient_grid_bookkeeping() -> None:
    """{i, x, y, w, h} IS the layout state; react-grid-layout re-derives the rest every render."""
    item = {"i": "a", "x": 0, "y": 0, "w": 4, "h": 3, "moved": False, "static": False, "minW": 2}
    parsed = LayoutUpdate(layout=[item], version=0).layout[0]
    assert parsed.model_dump() == {"i": "a", "x": 0, "y": 0, "w": 4, "h": 3}
