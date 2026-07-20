"""Unit tests: OpenAPI schema exposes the SSE frame contract and typed search response.

No DB needed — app.openapi() builds the schema purely from route/model introspection.
"""

from app.main import app
from app.models.activity import EventType


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


def test_users_search_response_is_typed_not_bare_object() -> None:
    schema = app.openapi()
    search_op = schema["paths"]["/api/users/search"]["get"]
    response_schema = search_op["responses"]["200"]["content"]["application/json"]["schema"]

    # list[UserSearchResult] serializes as {"type": "array", "items": {"$ref": ...}}
    assert response_schema.get("type") == "array"
    items = response_schema["items"]
    ref = items.get("$ref")
    assert ref is not None, f"expected a $ref to a named model, got {items}"
    model_name = ref.rsplit("/", 1)[-1]
    model_schema = schema["components"]["schemas"][model_name]
    props = model_schema.get("properties", {})
    for field in ("id", "display_name", "email"):
        assert field in props


def test_event_type_has_no_membership_members() -> None:
    names = EventType.__members__
    for bad in ("membership_added", "membership_removed", "membership_role_changed"):
        assert bad not in names
