"""Resize floors must be enforced by the API without stranding older layouts."""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.dashboard import DashboardWidget
from app.services.sessions import start_session
from tests.helpers import make_db_dashboard, make_db_user, set_csrf


@pytest.mark.parametrize(
    ("kind", "saved_size", "requested_size", "accepted"),
    [
        ("clock", (4, 6), (4, 4), True),
        ("clock", (4, 6), (3, 4), False),
        ("clock", (4, 6), (4, 3), False),
        ("calendar", (12, 8), (8, 8), True),
        ("calendar", (12, 8), (7, 8), False),
        ("calendar", (12, 8), (8, 7), False),
        ("clock", (2, 3), (2, 3), True),
        ("clock", (2, 3), (2, 2), False),
        ("clock", (2, 3), (4, 6), True),
    ],
)
async def test_layout_write_enforces_type_and_legacy_floors(
    client: AsyncClient,
    db_session: AsyncSession,
    kind: str,
    saved_size: tuple[int, int],
    requested_size: tuple[int, int],
    accepted: bool,
) -> None:
    owner = await make_db_user(db_session)
    board = await make_db_dashboard(db_session, owner)
    widget = DashboardWidget(id=uuid.uuid4(), dashboard_id=board.id, widget_type=kind, config={})
    db_session.add(widget)
    saved = {"i": str(widget.id), "x": 0, "y": 0, "w": saved_size[0], "h": saved_size[1]}
    board.layout = [saved]
    _, raw = await start_session(owner.id, db_session)
    await db_session.flush()
    client.cookies.set(settings.session_cookie_name, raw)
    set_csrf(client)
    response = await client.put(
        f"/api/dashboards/{board.id}/layout",
        json={
            "version": board.version,
            "layout": [{**saved, "w": requested_size[0], "h": requested_size[1]}],
        },
    )
    assert response.status_code == (200 if accepted else 422), response.text
    if not accepted:
        assert board.layout == [saved]
