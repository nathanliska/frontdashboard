"""Database-level invariants that `alembic check` cannot see.

The migration drift check compares tables, columns, indexes and FKs — it is blind to CHECK
constraints and to the predicate on a partial index. Both are asserted here by trying to write the
state they forbid, so a migration that quietly drops one fails the build.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.calendar import CalendarEvent, CalendarEventOverride
from app.models.dashboard import Dashboard, DashboardWidget
from app.models.share import EffectiveRole, PrincipalType, ResourceShare, ResourceType
from tests.helpers import (
    create_calendar_event,
    create_dashboard,
    current_user,
    make_db_dashboard,
    make_db_user,
)


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


def _share(dashboard_id: uuid.UUID, principal_id: uuid.UUID, granted_by: uuid.UUID) -> ResourceShare:
    return ResourceShare(
        resource_type=ResourceType.dashboard,
        resource_id=dashboard_id,
        principal_type=PrincipalType.user,
        principal_id=principal_id,
        role=EffectiveRole.viewer,
        granted_by=granted_by,
    )


async def test_a_share_must_name_a_real_dashboard(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    recipient = await make_db_user(db_session, label="recipient")

    db_session.add(_share(uuid.uuid4(), recipient.id, owner.id))

    # `resource_id` is polymorphic in principle but not in practice, so it carries a foreign key:
    # a grant on a dashboard that never existed is not a state the application should have to be
    # careful about.
    with pytest.raises(IntegrityError, match="fk_resource_shares_resource_id"):
        await db_session.flush()


async def test_a_share_must_name_a_real_user(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)

    db_session.add(_share(dashboard.id, uuid.uuid4(), owner.id))

    with pytest.raises(IntegrityError, match="fk_resource_shares_principal_id"):
        await db_session.flush()


async def test_only_dashboards_can_be_shared(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    recipient = await make_db_user(db_session, label="recipient")
    dashboard = await make_db_dashboard(db_session, owner)

    share = _share(dashboard.id, recipient.id, owner.id)
    share.resource_type = ResourceType.list
    db_session.add(share)

    # Lists and events inherit access from their dashboard (ADR-001) and their `/shares` endpoints
    # are 409 stubs, so a row of this shape can only be a bug. The CHECK is also what makes the
    # `resource_id` foreign key above sound: without it the column could name a list instead.
    with pytest.raises(IntegrityError, match="ck_resource_shares_resource_type"):
        await db_session.flush()


async def test_only_users_can_hold_a_share(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)

    # Raw SQL because `PrincipalType` has exactly one member — there is no way to express the
    # forbidden value through the ORM, which is the point of asserting it at this level.
    with pytest.raises(IntegrityError, match="ck_resource_shares_principal_type"):
        await db_session.execute(
            text(
                """
                INSERT INTO resource_shares
                    (id, resource_type, resource_id, principal_type, principal_id, role, granted_by)
                VALUES (:id, 'dashboard', :resource_id, 'group', :principal_id, 'viewer', :granted_by)
                """
            ),
            {
                "id": uuid.uuid4(),
                "resource_id": dashboard.id,
                "principal_id": owner.id,
                "granted_by": owner.id,
            },
        )


async def test_a_share_role_must_be_storable(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    recipient = await make_db_user(db_session, label="recipient")
    dashboard = await make_db_dashboard(db_session, owner)

    # Raw SQL because the ORM's `ShareRole` cannot express "owner" — which is the point: the CHECK
    # is the only layer that can refuse a row written behind the application's back.
    with pytest.raises(IntegrityError, match="ck_resource_shares_role"):
        await db_session.execute(
            text(
                """
                INSERT INTO resource_shares
                    (id, resource_type, resource_id, principal_type, principal_id, role, granted_by)
                VALUES (:id, 'dashboard', :resource_id, 'user', :principal_id, 'owner', :granted_by)
                """
            ),
            {
                "id": uuid.uuid4(),
                "resource_id": dashboard.id,
                "principal_id": recipient.id,
                "granted_by": owner.id,
            },
        )


async def test_an_invite_role_must_be_storable(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    dashboard = await make_db_dashboard(db_session, owner)

    with pytest.raises(IntegrityError, match="ck_dashboard_invites_role"):
        await db_session.execute(
            text(
                """
                INSERT INTO dashboard_invites
                    (id, dashboard_id, code_hash, role, created_by, expires_at)
                VALUES (:id, :dashboard_id, :code_hash, 'owner', :created_by, now() + interval '1 hour')
                """
            ),
            {
                "id": uuid.uuid4(),
                "dashboard_id": dashboard.id,
                "code_hash": "not-a-real-hash-" + uuid.uuid4().hex,
                "created_by": owner.id,
            },
        )


async def test_purging_a_dashboard_takes_its_shares_with_it(db_session: AsyncSession) -> None:
    owner = await make_db_user(db_session, label="owner")
    recipient = await make_db_user(db_session, label="recipient")
    dashboard = await make_db_dashboard(db_session, owner)
    db_session.add(_share(dashboard.id, recipient.id, owner.id))
    await db_session.flush()

    await db_session.execute(delete(Dashboard).where(Dashboard.id == dashboard.id))

    # ON DELETE CASCADE, not a sweep the trash reaper has to remember: the reaper's hand-ordered
    # share deletes were removed with this constraint, so this is the whole guarantee now.
    # Counted rather than selected — the identity map would happily hand back the deleted row.
    remaining = await db_session.scalar(select(func.count()).select_from(ResourceShare).where(ResourceShare.resource_id == dashboard.id))
    assert remaining == 0
