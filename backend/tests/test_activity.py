"""Tests for activity event logging.

Verifies that mutations emit the correct ActivityEvent rows with accurate
event_type, actor, and entity metadata. Completeness check: after each
mutation there should be exactly one more event than before.
"""

import json
import re
import uuid
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent, EventType
from app.services.activity import log_event
from app.services.notifications import stage_notification
from app.sse.events import build_activity_sse_dict, build_notification_sse_dicts
from tests.helpers import CSRF, create_dashboard, create_list, create_list_item, make_db_user, register_user, set_csrf

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_FEED_UTILS_PATH = Path(__file__).parents[2] / "frontend/src/utils/notifications/notificationFeedUtils.ts"


def test_all_activity_event_types_have_frontend_presentations() -> None:
    formatter_source = _FEED_UTILS_PATH.read_text().split("export function formatActivityEvent", 1)[1]
    formatter_source = formatter_source.split("default:", 1)[0]
    mapped_event_types = set(re.findall(r"case '([^']+)':", formatter_source))

    assert mapped_event_types == {event_type.value for event_type in EventType}


def test_all_activity_event_types_are_reachable_in_the_filter() -> None:
    """A type in no category is one the Activity tab can never be narrowed to."""
    categories = _FEED_UTILS_PATH.read_text().split("const ACTIVITY_CATEGORIES", 1)[1].split("\n]", 1)[0]
    categorised = set(re.findall(r"'([a-z]+\.[a-z_.]+)'", categories))

    assert categorised == {event_type.value for event_type in EventType}


async def _make_list(client: AsyncClient, dashboard_id: str, **kwargs) -> dict:
    # File-local default: "My List" is asserted back out of event payloads below.
    return await create_list(client, dashboard_id, **({"name": "My List"} | kwargs))


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
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_created
    assert event.entity_type == "list"
    assert str(event.entity_id) == lst["id"]
    assert event.actor_display_name == "Alice"


@pytest.mark.asyncio
async def test_list_updated_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    set_csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}", json={"name": "Renamed"})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_updated
    assert str(event.entity_id) == lst["id"]


@pytest.mark.asyncio
async def test_list_events_include_client_mutation_id_in_payload(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await register_user(db_client, "alice-client-mutation@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    set_csrf(db_client)
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
    await register_user(db_client, "alice-item-client-mutation@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await create_list_item(db_client, lst["id"])

    set_csrf(db_client)
    resp = await db_client.patch(
        f"/api/lists/{lst['id']}/items/{item['id']}",
        json={"checked": True},
        headers={"X-Client-Mutation-Id": "item-check-123", "x-csrf-token": CSRF},
    )
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.payload["client_mutation_id"] == "item-check-123"


@pytest.mark.asyncio
async def test_list_deleted_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])

    set_csrf(db_client)
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
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await create_list_item(db_client, lst["id"], text="Eggs")

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_created
    assert event.entity_type == "list_item"
    assert str(event.entity_id) == item["id"]
    assert event.actor_display_name == "Alice"
    assert event.payload["text"] == "Eggs"
    assert event.payload["list_name"] == "My List"


@pytest.mark.asyncio
async def test_list_item_checked_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await create_list_item(db_client, lst["id"])

    set_csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"checked": True})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_checked
    assert str(event.entity_id) == item["id"]
    assert event.payload["text"] == "Milk"
    assert event.payload["list_name"] == "My List"


@pytest.mark.asyncio
async def test_list_item_updated_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await create_list_item(db_client, lst["id"])

    set_csrf(db_client)
    resp = await db_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"text": "New text"})
    assert resp.status_code == 200

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_updated
    assert str(event.entity_id) == item["id"]
    assert event.payload["text"] == "New text"
    assert event.payload["list_name"] == "My List"


@pytest.mark.asyncio
async def test_list_item_deleted_event(db_client: AsyncClient, db_session: AsyncSession) -> None:
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    item = await create_list_item(db_client, lst["id"])

    set_csrf(db_client)
    resp = await db_client.delete(f"/api/lists/{lst['id']}/items/{item['id']}")
    assert resp.status_code == 204

    event = await _latest_event(db_session)
    assert event.event_type == EventType.list_item_deleted
    assert str(event.entity_id) == item["id"]
    assert event.payload["text"] == "Milk"
    assert event.payload["list_name"] == "My List"


# ---------------------------------------------------------------------------
# Dashboard events
# ---------------------------------------------------------------------------


async def test_dashboard_layout_and_widget_activity_survives_a_reload(auth_client: AsyncClient) -> None:
    """A widget move must be readable back from the feed, not only pushed once over SSE.

    The rows were always written; the read path filtered them out, so the entry the SSE append
    put on screen disappeared at the next load. Asserts on the endpoint for that reason.
    """
    dashboard = await create_dashboard(auth_client, name="Board")

    set_csrf(auth_client)
    add_resp = await auth_client.post(
        f"/api/dashboards/{dashboard['id']}/widgets",
        json={"widget_type": "clock", "config": {}},
    )
    assert add_resp.status_code == 201
    added = add_resp.json()
    widget_id = added["widgets"][0]["id"]

    set_csrf(auth_client)
    layout_resp = await auth_client.put(
        f"/api/dashboards/{dashboard['id']}/layout",
        json={"layout": [{"i": widget_id, "x": 2, "y": 1, "w": 2, "h": 2}], "version": added["version"]},
    )
    assert layout_resp.status_code == 200

    set_csrf(auth_client)
    delete_resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/widgets/{widget_id}")
    assert delete_resp.status_code == 204

    feed = (await auth_client.get("/api/activity")).json()
    updates = [event for event in feed if event["event_type"] == "dashboard.updated"]
    assert [event["payload"]["changed_fields"] for event in updates] == [
        ["widgets", "layout"],
        ["layout"],
        ["widgets", "layout"],
    ]
    # Newest first: the removal, the move, then the add.
    assert [event["payload"].get("widget_action") for event in updates] == ["removed", None, "added"]
    # Without the name the feed can only say "a dashboard".
    assert {event["payload"]["name"] for event in updates} == {"Board"}
    assert {event["payload"]["widget_type"] for event in updates if "widget_type" in event["payload"]} == {"clock"}


async def test_restore_names_the_dashboard_it_brought_back(auth_client: AsyncClient) -> None:
    """Restore staged only `changed_fields`, so the feed could only say "a dashboard"."""
    dashboard = await create_dashboard(auth_client, name="Kitchen")

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204
    set_csrf(auth_client)
    assert (await auth_client.post(f"/api/dashboards/{dashboard['id']}/restore")).status_code == 200

    feed = (await auth_client.get("/api/activity")).json()
    restored = next(event for event in feed if event["payload"].get("changed_fields") == ["restored"])
    assert restored["payload"]["name"] == "Kitchen"


async def test_the_feed_withholds_nothing_from_its_own_log(auth_client: AsyncClient) -> None:
    """Checkbox churn is collapsed in the client, not dropped here — the two must not disagree."""
    dashboard = await create_dashboard(auth_client, name="Board")
    lst = await create_list(auth_client, dashboard["id"], name="Chores")
    item = await create_list_item(auth_client, lst["id"], text="Vacuum")

    set_csrf(auth_client)
    check_resp = await auth_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"checked": True})
    assert check_resp.status_code == 200

    feed = (await auth_client.get("/api/activity")).json()
    checked = next(event for event in feed if event["event_type"] == "list.item.checked")
    # The client keys its collapse on the list, so a summarized row has no name without this.
    assert checked["payload"]["list_name"] == "Chores"


async def test_activity_narrows_to_every_named_event_type(auth_client: AsyncClient) -> None:
    """A category filter sends its whole group, so one request must answer with all of them."""
    dashboard = await create_dashboard(auth_client, name="Board")
    lst = await create_list(auth_client, dashboard["id"], name="Chores")
    await create_list_item(auth_client, lst["id"], text="Vacuum")

    resp = await auth_client.get(
        "/api/activity",
        params=[("event_type", "list.created"), ("event_type", "dashboard.created")],
    )
    assert resp.status_code == 200
    assert [event["event_type"] for event in resp.json()] == ["list.created", "dashboard.created"]


async def test_activity_rejects_an_absurd_number_of_filters(auth_client: AsyncClient) -> None:
    resp = await auth_client.get(
        "/api/activity",
        params=[("event_type", f"made.up.{n}") for n in range(41)],
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Too many event_type filters"


@pytest.mark.asyncio
async def test_event_id_is_monotonically_increasing(db_client: AsyncClient, db_session: AsyncSession) -> None:
    """event_id values must be strictly increasing across consecutive inserts."""
    await register_user(db_client, "alice@example.com", display_name="Alice")
    dashboard = await create_dashboard(db_client)
    lst = await _make_list(db_client, dashboard["id"])
    await create_list_item(db_client, lst["id"], text="A")
    await create_list_item(db_client, lst["id"], text="B")

    result = await db_session.execute(select(ActivityEvent).order_by(ActivityEvent.event_id))
    events = result.scalars().all()
    assert len(events) >= 3  # list_created + 2x item_created
    ids = [e.event_id for e in events]
    assert ids == sorted(ids)
    assert len(ids) == len(set(ids))  # all unique


async def test_sse_builders_serialise_staged_rows_without_per_row_refreshes(db_session: AsyncSession) -> None:
    """Pins the flush contract behind #25's refresh removal.

    Notifications are fully assigned in Python at staging, so build_notification_sse_dicts must
    serialise a flushed batch with no per-row refresh; the activity builder needs exactly one
    targeted fetch (the sequence-assigned event_id, which eager_defaults does not bring back).
    If a server-generated column is ever added to Notification, this fails here instead of the
    SSE path quietly serialising None at runtime.
    """
    user = await make_db_user(db_session, label="flush-pin")
    event = log_event(
        db_session,
        event_type=EventType.list_created,
        actor_id=user.id,
        actor_display_name=user.display_name,
        entity_type="list",
        entity_id=uuid.uuid4(),
    )
    notifications = [stage_notification(db_session, user_id=user.id, type="list.created", title="t", body=str(n)) for n in range(3)]

    activity_message = await build_activity_sse_dict(db_session, event)
    activity_payload = json.loads(activity_message["data"])
    assert isinstance(activity_payload["event_id"], int)
    assert activity_payload["created_at"] is not None

    messages = await build_notification_sse_dicts(db_session, notifications)
    payloads = [json.loads(m["data"]) for m in messages]
    assert [p["body"] for p in payloads] == ["0", "1", "2"]
    assert all(p["id"] and p["created_at"] for p in payloads)
