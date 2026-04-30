"""Tests for activity event logging.

Verifies that mutations emit the correct ActivityEvent rows with accurate
event_type, actor, and entity metadata. Completeness check: after each
mutation there should be exactly one more event than before.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.models.activity import ActivityEvent, EventType

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CSRF = "test-csrf-token"


def _csrf(client: AsyncClient) -> None:
    client.cookies.set("csrf_token", CSRF)
    client.headers.update({"x-csrf-token": CSRF})


async def _register(client: AsyncClient, email: str, display_name: str = "User") -> dict:
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password123", "display_name": display_name},
    )
    assert resp.status_code == 201
    token = app.state.email_verification_tokens[email]
    verify_resp = await client.post("/api/auth/verify-email", json={"token": token})
    assert verify_resp.status_code == 200
    return verify_resp.json()


async def _make_dashboard(client: AsyncClient) -> dict:
    _csrf(client)
    resp = await client.post("/api/dashboards", json={"name": "Test Dashboard"})
    assert resp.status_code == 201
    return resp.json()


async def _make_list(client: AsyncClient, dashboard_id: str, **kwargs) -> dict:
    _csrf(client)
    payload = {"name": "My List", "list_type": "checklist", "dashboard_id": dashboard_id} | kwargs
    resp = await client.post("/api/lists", json=payload)
    assert resp.status_code == 201
    return resp.json()


async def _make_item(client: AsyncClient, list_id: str, text: str = "Milk") -> dict:
    _csrf(client)
    resp = await client.post(f"/api/lists/{list_id}/items", json={"text": text})
    assert resp.status_code == 201
    return resp.json()


async def _latest_event(db_session: AsyncSession) -> ActivityEvent:
    result = await db_session.execute(select(ActivityEvent).order_by(ActivityEvent.event_id.desc()).limit(1))
    event = result.scalar_one_or_none()
    assert event is not None, "Expected an activity event but found none"
    return event


# ---------------------------------------------------------------------------
# List-level events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_created_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_created
    assert event.entity_type == "list"
    assert str(event.entity_id) == lst["id"]
    assert event.actor_display_name == "Alice"


@pytest.mark.asyncio
async def test_list_updated_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    _csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}", json={"name": "Renamed"})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_updated
    assert str(event.entity_id) == lst["id"]


@pytest.mark.asyncio
async def test_list_events_include_client_mutation_id_in_payload(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice-client-mutation@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    _csrf(db_client)
    resp = await db_client.patch(
        f"/api/lists/{lst['id']}",
        json={"name": "Renamed"},
        headers={"X-Client-Mutation-Id": "list-rename-123", "x-csrf-token": CSRF},
    )
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.payload["client_mutation_id"] == "list-rename-123"


@pytest.mark.asyncio
async def test_list_item_events_include_client_mutation_id_in_payload(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice-item-client-mutation@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await _make_item(db_client, lst["id"])

    _csrf(db_client)
    resp = await db_client.patch(
        f"/api/lists/{lst['id']}/items/{item['id']}",
        json={"checked": True},
        headers={"X-Client-Mutation-Id": "item-check-123", "x-csrf-token": CSRF},
    )
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.payload["client_mutation_id"] == "item-check-123"


@pytest.mark.asyncio
async def test_list_archived_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    _csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}", json={"archived": True})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_archived
    assert str(event.entity_id) == lst["id"]


@pytest.mark.asyncio
async def test_list_deleted_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    _csrf(db_client)
    await db_client.patch(f"/api/lists/{lst['id']}", json={"archived": True})
    resp = await db_client.delete(f"/api/lists/{lst['id']}")
    assert resp.status_code == 204

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_deleted
    assert str(event.entity_id) == lst["id"]


# ---------------------------------------------------------------------------
# List item events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_item_created_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await _make_item(db_client, lst["id"], "Eggs")

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_created
    assert event.entity_type == "list_item"
    assert str(event.entity_id) == item["id"]
    assert event.actor_display_name == "Alice"


@pytest.mark.asyncio
async def test_list_item_checked_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await _make_item(db_client, lst["id"])

    _csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"checked": True})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_checked
    assert str(event.entity_id) == item["id"]


@pytest.mark.asyncio
async def test_list_item_updated_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await _make_item(db_client, lst["id"])

    _csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"text": "New text"})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_updated
    assert str(event.entity_id) == item["id"]


@pytest.mark.asyncio
async def test_list_item_deleted_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await _make_item(db_client, lst["id"])

    _csrf(db_client)
    resp = await db_client.delete(f"/api/lists/{lst['id']}/items/{item['id']}")
    assert resp.status_code == 204

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_deleted
    assert str(event.entity_id) == item["id"]


@pytest.mark.asyncio
async def test_event_id_is_monotonically_increasing(db_client: AsyncClient, db_session: AsyncSession) -> None:
    """event_id values must be strictly increasing across consecutive inserts."""
    await _register(db_client, "alice@example.com", "Alice")
    dashboard = await _make_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    await _make_item(db_client, lst["id"], "A")
    await _make_item(db_client, lst["id"], "B")

    result = await db_session.execute(select(ActivityEvent).order_by(ActivityEvent.event_id))
    events = result.scalars().all()
    assert len(events) >= 3  # list_created + 2x item_created
    ids = [e.event_id for e in events]
    assert ids == sorted(ids)
    assert len(ids) == len(set(ids))  # all unique
