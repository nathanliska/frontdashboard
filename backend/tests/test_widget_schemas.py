"""Unit tests for the widget response discriminated union (finding #23, slice 1).

No DB fixtures are used here, so these are auto-marked `unit` and run under
`pytest -m unit` with no Docker/Postgres required.
"""

import uuid
from datetime import UTC, datetime

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.dashboards import (
    AgendaWidgetResponse,
    CalendarWidgetResponse,
    ClockWidgetResponse,
    ListWidgetResponse,
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
    """`view` must be `str`, not a `Literal` — a stored value outside a fixed set
    would otherwise fail validation (500 on read) instead of just being un-narrowed."""
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
    """Documents the closed set: the union has no fallback variant, so a stored
    widget_type outside {clock, calendar, list, agenda} is a hard validation error
    rather than being silently accepted."""
    payload = {
        **_base_fields(),
        "widget_type": "unknown",
        "config": {},
    }
    with pytest.raises(ValidationError):
        adapter.validate_python(payload)
