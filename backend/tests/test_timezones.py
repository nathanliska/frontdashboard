"""Every field that stores a zone name takes it through `TimeZoneName`."""

import zoneinfo
from collections.abc import Callable, Generator
from datetime import UTC, datetime

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app.schemas.calendar import CalendarEventCreate, CalendarEventUpdate, CalendarOccurrenceUpdate
from app.schemas.dashboards import WIDGET_CONFIG_MODELS, ClockWidgetConfig, WidgetCreate
from app.schemas.timezones import _ZONES

_WIDGET_CREATE: TypeAdapter[BaseModel] = TypeAdapter(WidgetCreate)
_START = datetime(2026, 1, 5, 9, tzinfo=UTC)
_END = datetime(2026, 1, 5, 10, tzinfo=UTC)

WRITES: dict[str, Callable[[str], BaseModel]] = {
    "event create": lambda tz: CalendarEventCreate(
        title="t", starts_at=_START, ends_at=_END, timezone=tz, dashboard_id="00000000-0000-4000-8000-000000000001"
    ),
    "event update": lambda tz: CalendarEventUpdate(timezone=tz),
    "occurrence update": lambda tz: CalendarOccurrenceUpdate(occurrence_start=_START, timezone=tz),
    "clock create": lambda tz: _WIDGET_CREATE.validate_python({"widget_type": "clock", "config": {"timezone": tz}}),
    "clock config patch": lambda tz: WIDGET_CONFIG_MODELS["clock"].model_validate({"timezone": tz}),
}


@pytest.fixture
def no_system_zones() -> Generator[None]:
    system_paths = zoneinfo.TZPATH
    zoneinfo.reset_tzpath(to=[])
    zoneinfo.ZoneInfo.clear_cache()
    yield
    zoneinfo.reset_tzpath(to=system_paths)
    zoneinfo.ZoneInfo.clear_cache()


@pytest.mark.parametrize("write", WRITES.values(), ids=WRITES.keys())
@pytest.mark.parametrize(
    "name",
    [
        "posixrules",  # host files zoneinfo loads that are not zones at all
        "localtime",
        "Factory",  # a placeholder zone, which a browser's formatter throws on
        "posix/America/New_York",
        "Not/A_Zone",
        "東" * 86,  # more bytes than a path component holds
    ],
)
def test_every_write_refuses_a_name_a_browser_cannot_format(write: Callable[[str], BaseModel], name: str) -> None:
    with pytest.raises(ValidationError, match="valid IANA timezone|at most 100 characters"):
        write(name)


@pytest.mark.parametrize("write", WRITES.values(), ids=WRITES.keys())
def test_every_write_accepts_a_legacy_name_browsers_still_send(write: Callable[[str], BaseModel], no_system_zones: None) -> None:
    write("Asia/Calcutta")


def test_every_accepted_name_loads_without_the_system_database(no_system_zones: None) -> None:
    # The list is the package's, so the package must be able to load all of it.
    for name in _ZONES:
        zoneinfo.ZoneInfo(name)


def test_a_clock_read_keeps_a_zone_saved_before_the_check() -> None:
    # Refusing it here would fail every load of its dashboard; the widget falls back instead.
    assert ClockWidgetConfig.model_validate({"timezone": "localtime"}).timezone == "localtime"
