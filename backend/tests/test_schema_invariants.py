"""Database-level invariants that `alembic check` cannot see.

The migration drift check compares tables, columns, indexes and FKs — it is blind to CHECK
constraints and to the predicate on a partial index. Both are asserted here by trying to write the
state they forbid, so a migration that quietly drops one fails the build.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.calendar import CalendarEvent, CalendarEventOverride
from app.models.dashboard import DashboardWidget
from tests.helpers import create_calendar_event, create_dashboard, current_user


async def test_widget_cannot_bind_half_a_resource(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)

    db_session.add(
        DashboardWidget(
            dashboard_id=uuid.UUID(dashboard["id"]),
            widget_type="list",
            config={},
            resource_type="list",
            resource_id=None,
        )
    )
    # A widget binds a resource or it does not; the app cannot read half a binding.
    # Matching the constraint name keeps this from passing on some unrelated integrity error.
    with pytest.raises(IntegrityError, match="ck_dashboard_widgets_resource_pair"):
        await db_session.flush()


async def test_a_resource_can_only_be_bound_once_per_dashboard(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    resource_id = uuid.uuid4()

    for _ in range(2):
        db_session.add(
            DashboardWidget(
                dashboard_id=uuid.UUID(dashboard["id"]),
                widget_type="list",
                config={},
                resource_type="list",
                resource_id=resource_id,
            )
        )

    # The router checks first to return a friendly 409, but that read-before-insert races itself
    # under concurrent adds — this index is the actual guarantee.
    with pytest.raises(IntegrityError, match="uq_dashboard_widgets_resource_binding"):
        await db_session.flush()


async def test_unbound_widgets_are_exempt_from_the_uniqueness_rule(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)

    for _ in range(2):
        db_session.add(
            DashboardWidget(
                dashboard_id=uuid.UUID(dashboard["id"]),
                widget_type="clock",
                config={},
                resource_type=None,
                resource_id=None,
            )
        )

    # Two clocks on one dashboard is a legitimate layout — the index is partial for this reason.
    await db_session.flush()
    result = await db_session.execute(select(DashboardWidget).where(DashboardWidget.dashboard_id == uuid.UUID(dashboard["id"])))
    assert len(result.scalars().all()) == 2


async def test_override_cannot_end_before_it_starts(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    me = await current_user(auth_client)

    stored = await db_session.execute(select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"])))
    parent = stored.scalar_one()

    db_session.add(
        CalendarEventOverride(
            calendar_event_id=parent.id,
            created_by=uuid.UUID(me["id"]),
            updated_by=uuid.UUID(me["id"]),
            occurrence_start=parent.starts_at,
            starts_at=parent.ends_at,
            ends_at=parent.starts_at,
        )
    )
    # Mirrors the parent event's own time-range check.
    with pytest.raises(IntegrityError, match="ck_calendar_event_overrides_time_range"):
        await db_session.flush()


async def test_override_may_leave_timing_alone(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    dashboard = await create_dashboard(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"])
    me = await current_user(auth_client)

    stored = await db_session.execute(select(CalendarEvent).where(CalendarEvent.id == uuid.UUID(event["id"])))
    parent = stored.scalar_one()

    db_session.add(
        CalendarEventOverride(
            calendar_event_id=parent.id,
            created_by=uuid.UUID(me["id"]),
            updated_by=uuid.UUID(me["id"]),
            occurrence_start=parent.starts_at,
            cancelled=True,
        )
    )
    # Cancelling an occurrence supplies no times at all; the constraint must not bind then.
    await db_session.flush()
