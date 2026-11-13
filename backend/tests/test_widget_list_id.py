"""A list widget names its list in `list_id`, a real foreign key.

The pair it replaced could not carry one, so nothing stopped a widget naming a list that was gone.
"""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import DashboardWidget
from tests.helpers import add_widget, create_dashboard, create_list


async def test_list_id_must_name_a_real_list(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    db_session.add(
        DashboardWidget(
            dashboard_id=uuid.UUID(dashboard["id"]),
            widget_type="list",
            config={},
            list_id=uuid.uuid4(),
        )
    )

    with pytest.raises(IntegrityError, match="fk_dashboard_widgets_list_id"):
        await db_session.flush()


async def test_a_widget_can_be_bound_by_list_id(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"], name="Groceries")
    url = f"/api/dashboards/{dashboard['id']}/widgets"

    resp = await auth_client.post(url, json={"widget_type": "list", "list_id": lst["id"], "config": {}})

    assert resp.status_code == 201, resp.text
    widget = resp.json()["widgets"][-1]
    assert widget["list_id"] == lst["id"]


async def test_the_retired_binding_fields_are_refused(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    body = {"widget_type": "list", "resource_type": "list", "resource_id": str(uuid.uuid4()), "config": {}}

    resp = await auth_client.post(f"/api/dashboards/{dashboard['id']}/widgets", json=body)

    assert resp.status_code == 422


async def test_trashing_a_list_locks_its_dashboard_before_looking_for_widgets(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    """Ordering, not outcome: a race needs two committed transactions, which this harness shares."""
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"], name="Groceries")
    statements: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_rest: Any) -> None:
        statements.append(statement)

    bind = db_session.get_bind()
    event.listen(bind, "before_cursor_execute", record)
    try:
        resp = await auth_client.delete(f"/api/lists/{lst['id']}")
    finally:
        event.remove(bind, "before_cursor_execute", record)

    assert resp.status_code == 204, resp.text
    lock = next(i for i, sql in enumerate(statements) if "FROM dashboards" in sql and "FOR UPDATE" in sql)
    widget_read = next(i for i, sql in enumerate(statements) if "FROM dashboard_widgets" in sql)
    assert lock < widget_read


async def test_purging_a_list_row_takes_a_widget_still_keyed_to_it(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    widget = (await add_widget(auth_client, dashboard["id"], "list", {"name": "Errands"}))["widgets"][-1]

    await db_session.execute(text("DELETE FROM lists WHERE id = :id"), {"id": widget["list_id"]})

    remaining = await db_session.scalar(select(func.count()).select_from(DashboardWidget).where(DashboardWidget.id == uuid.UUID(widget["id"])))
    assert remaining == 0
