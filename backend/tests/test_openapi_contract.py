"""Unit tests: OpenAPI schema exposes the SSE frame contract and typed search response.

No DB needed — app.openapi() builds the schema purely from route/model introspection.
"""

from app.main import app
from app.models.activity import EventType
from app.openapi_export import build_schema, widen_const_to_enum


def _schemas() -> dict:
    return app.openapi()["components"]["schemas"]


def test_sse_frame_models_registered_in_openapi() -> None:
    schemas = _schemas()
    for name in (
        "ActivitySseEvent",
        "NotificationSseEvent",
        "ConnectedSseEvent",
        "ResyncSseEvent",
        "EventType",
    ):
        assert name in schemas, f"{name} missing from components.schemas"


def test_event_type_enum_excludes_membership_and_includes_known_values() -> None:
    schemas = _schemas()
    enum_values = schemas["EventType"]["enum"]
    assert "list.created" in enum_values
    for bad in ("membership.added", "membership.removed", "membership.role_changed"):
        assert bad not in enum_values


def test_event_type_has_no_membership_members() -> None:
    names = EventType.__members__
    for bad in ("membership_added", "membership_removed", "membership_role_changed"):
        assert bad not in names


def test_widen_const_to_enum_rewrites_nested_consts_without_mutating() -> None:
    source = {
        "properties": {"widget_type": {"const": "clock", "type": "string"}},
        "oneOf": [{"const": 3}, {"type": "string"}],
    }

    widened = widen_const_to_enum(source)

    assert widened["properties"]["widget_type"]["enum"] == ["clock"]
    assert widened["properties"]["widget_type"]["const"] == "clock"
    assert widened["oneOf"][0]["enum"] == [3]
    assert widened["oneOf"][1] == {"type": "string"}
    assert "enum" not in source["properties"]["widget_type"], "input was mutated"


def test_widen_const_to_enum_keeps_an_existing_enum() -> None:
    assert widen_const_to_enum({"const": "a", "enum": ["a", "b"]})["enum"] == ["a", "b"]


def test_exported_widget_discriminators_survive_codegen() -> None:
    """typed-openapi only emits `z.literal` for `enum`, so the export must carry one.

    Without this the generated widget union degrades to `widget_type: z.string()` and stops
    narrowing on the frontend.
    """
    schemas = build_schema()["components"]["schemas"]
    for name, value in (
        ("ClockWidgetResponse", "clock"),
        ("CalendarWidgetResponse", "calendar"),
        ("ListWidgetResponse", "list"),
        ("AgendaWidgetResponse", "agenda"),
    ):
        assert schemas[name]["properties"]["widget_type"]["enum"] == [value]
