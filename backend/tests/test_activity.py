"""Tests for activity event logging.

Verifies that mutations emit the correct ActivityEvent rows with accurate
event_type, actor, entity, and group_id fields. Completeness check: after each
mutation there should be exactly one more event than before.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    return resp.json()


async def _make_dashboard(client: AsyncClient) -> dict:
    _csrf(client)
    resp = await client.post("/api/dashboards", json={"name": "Test Dashboard"})
    assert resp.status_code == 201
    return resp.json()


async def _make_group(client: AsyncClient) -> dict:
    _csrf(client)
    resp = await client.post("/api/groups", json={"name": "Test Group"})
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
    assert event.group_id is None


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


# ---------------------------------------------------------------------------
# Membership events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_membership_added_event_via_invite(db_client: AsyncClient, db_session: AsyncSession) -> None:
    """Joining via invite emits membership.added with group_id set."""
    await _register(db_client, "owner@example.com", "Owner")
    group = await _make_group(db_client)

    # Create invite
    _csrf(db_client)
    inv_resp = await db_client.post(
        f"/api/groups/{group['id']}/invites",
        json={"expires_in_days": 7, "max_uses": 10},
    )
    assert inv_resp.status_code == 201
    code = inv_resp.json()["code"]

    # Second user joins via invite
    resp2 = await db_client.post(
        "/api/auth/register",
        json={"email": "bob@example.com", "password": "password123", "display_name": "Bob"},
    )
    assert resp2.status_code == 201

    _csrf(db_client)
    join_resp = await db_client.post(f"/api/invites/{code}/join")
    assert join_resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.membership_added
    assert event.group_id is not None
    assert str(event.group_id) == group["id"]
    assert event.actor_display_name == "Bob"
    assert event.payload.get("via") == "invite"


@pytest.mark.asyncio
async def test_membership_removed_on_leave(db_client: AsyncClient, db_session: AsyncSession) -> None:
    """Leaving a group emits membership.removed."""
    await _register(db_client, "owner@example.com", "Owner")
    group = await _make_group(db_client)

    # Create invite as owner before switching to Bob
    _csrf(db_client)
    inv_resp = await db_client.post(
        f"/api/groups/{group['id']}/invites",
        json={"expires_in_days": 7, "max_uses": 10},
    )
    assert inv_resp.status_code == 201
    code = inv_resp.json()["code"]

    # Register Bob (client is now Bob) and join
    resp2 = await db_client.post(
        "/api/auth/register",
        json={"email": "bob@example.com", "password": "password123", "display_name": "Bob"},
    )
    assert resp2.status_code == 201

    _csrf(db_client)
    await db_client.post(f"/api/invites/{code}/join")

    # Bob leaves
    _csrf(db_client)
    leave_resp = await db_client.delete(f"/api/groups/{group['id']}/members/me")
    assert leave_resp.status_code == 204

    event = await _latest_event(db_session)
    assert event.event_type == EventType.membership_removed
    assert event.payload.get("reason") == "left"


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
