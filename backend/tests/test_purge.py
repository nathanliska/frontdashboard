"""Purging from the trash: the cascade goes, access is enforced, and the quota comes back."""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.base import Base
from app.models.calendar import CalendarEvent
from app.models.list import List, ListItem
from tests.helpers import (
    create_calendar_event,
    create_dashboard,
    create_list,
    create_list_item,
    register_client,
    set_csrf,
)


async def test_purging_a_dashboard_takes_its_whole_cascade(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    await create_list_item(auth_client, lst["id"], text="milk")
    await create_calendar_event(auth_client, dashboard["id"])

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}/trash")).status_code == 204

    # Nothing survives the purge — children have no ON DELETE, so a missed sweep would strand rows.
    for model in (List, ListItem, CalendarEvent):
        remaining = await db_session.scalar(select(func.count()).select_from(model))
        assert remaining == 0, model.__name__


def test_every_hand_swept_child_is_one_the_cascade_test_covers() -> None:
    """The same FK knowledge lives in two sweeps, so a new table can join one and be missed.

    `reap_expired_trash` deletes on a horizon and `purge_dashboard` deletes one row; neither can
    reuse the other's query. This is what keeps them honest: a child whose FK carries no ON DELETE
    and which the cascade test above does not assert on fails here, not in production.
    """
    covered = {List.__tablename__, ListItem.__tablename__, CalendarEvent.__tablename__}
    hand_swept = {
        table.name
        for table in Base.metadata.tables.values()
        for fk in table.foreign_keys
        if fk.target_fullname.split(".")[0] in {"dashboards", "lists"} and fk.ondelete != "CASCADE"
    }
    assert hand_swept == covered


async def test_purge_refuses_a_dashboard_that_is_not_trashed(auth_client: AsyncClient) -> None:
    """Only the trash can be emptied — a live dashboard must go through DELETE first."""
    dashboard = await create_dashboard(auth_client)

    set_csrf(auth_client)
    resp = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/trash")
    assert resp.status_code == 404


async def test_purge_is_refused_to_someone_elses_trash(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/dashboards/{dashboard['id']}")).status_code == 204

    other = await register_client("purge-other@example.com")
    try:
        set_csrf(other)
        resp = await other.delete(f"/api/dashboards/{dashboard['id']}/trash")
        assert resp.status_code == 404
    finally:
        await other.__aexit__(None, None, None)


async def test_purging_returns_the_quota_it_was_holding(auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The reason this exists: trashed rows count, so reclaiming them has to free the allowance."""
    monkeypatch.setattr(settings, "quota_items_per_user", 2)
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    await create_list_item(auth_client, lst["id"], text="one")
    await create_list_item(auth_client, lst["id"], text="two")

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/lists/{lst['id']}")).status_code == 204
    set_csrf(auth_client)
    resp = await auth_client.post("/api/lists", json={"name": "next", "list_type": "checklist", "dashboard_id": dashboard["id"]})
    assert resp.status_code == 201
    next_list = resp.json()

    # Still full: the trashed list's items keep occupying the quota.
    set_csrf(auth_client)
    blocked = await auth_client.post(f"/api/lists/{next_list['id']}/items", json={"text": "three"})
    assert blocked.status_code == 422

    set_csrf(auth_client)
    assert (await auth_client.delete(f"/api/lists/{lst['id']}/trash")).status_code == 204

    set_csrf(auth_client)
    allowed = await auth_client.post(f"/api/lists/{next_list['id']}/items", json={"text": "three"})
    assert allowed.status_code == 201


async def test_a_viewer_cannot_purge_a_list(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])

    viewer = await register_client("purge-viewer@example.com")
    try:
        me = await viewer.get("/api/auth/me")
        set_csrf(auth_client)
        shared = await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "viewer"},
        )
        assert shared.status_code == 201

        set_csrf(auth_client)
        assert (await auth_client.delete(f"/api/lists/{lst['id']}")).status_code == 204

        set_csrf(viewer)
        resp = await viewer.delete(f"/api/lists/{lst['id']}/trash")
        assert resp.status_code == 403
    finally:
        await viewer.__aexit__(None, None, None)
