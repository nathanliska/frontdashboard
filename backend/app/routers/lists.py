import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.config import settings
from app.database import get_db
from app.limiter import WRITE_LIMIT, limiter
from app.models.dashboard import Dashboard
from app.models.list import List, ListItem
from app.models.share import EffectiveRole, ResourceShare, ResourceType
from app.models.user import User
from app.schemas.lists import (
    ItemReorder,
    ListCreate,
    ListDetailResponse,
    ListItemCreate,
    ListItemResponse,
    ListItemUpdate,
    ListReorder,
    ListResponse,
    ListUpdate,
    TrashedListSummary,
)
from app.schemas.shares import InheritedDashboardAccessResponse, ResourceAccessResponse
from app.services import permissions
from app.services.activity import EventType, log_event
from app.services.dashboard_widgets import remove_resource_widgets
from app.services.quota import assert_under_quota, limit_message
from app.services.retention import purge_list
from app.services.shares import (
    dashboard_audience_user_ids,
    list_accessible_dashboard_ids,
    load_dashboard_access,
)
from app.sse.choreography import ClientIdHeader, Fanout, commit_and_broadcast
from app.sse.events import build_activity_sse_dict

router = APIRouter(prefix="/lists", tags=["lists"])


def _dashboard_fanout(message: dict, dashboard: Dashboard, shares: list[ResourceShare]) -> Fanout:
    """Address a frame to everyone who can see the dashboard, owner included."""
    return Fanout(message, dashboard_audience_user_ids(dashboard, shares))


async def _build_list_event_message(
    db: AsyncSession,
    *,
    event_type: EventType,
    current_user: User,
    dashboard: Dashboard,
    entity_type: str,
    entity_id: uuid.UUID,
    payload: dict[str, Any] | None = None,
    client_id: str | None = None,
) -> dict:
    event_payload = {"dashboard_id": str(dashboard.id), **(payload or {})}
    if client_id is not None:
        event_payload["origin_client_id"] = client_id
    activity = log_event(
        db,
        event_type=event_type,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type=entity_type,
        entity_id=entity_id,
        payload=event_payload,
    )
    return await build_activity_sse_dict(db, activity)


async def _get_list_access(
    list_id: uuid.UUID,
    user: User,
    db: AsyncSession,
    *,
    lock_for_update: bool = False,
) -> tuple[List, Dashboard, list[ResourceShare], EffectiveRole]:
    list_query = select(List).where(List.id == list_id, List.deleted_at.is_(None))
    if lock_for_update:
        list_query = list_query.with_for_update()

    result = await db.execute(list_query)
    lst = result.scalar_one_or_none()
    if lst is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    dashboard, shares, role = await load_dashboard_access(lst.dashboard_id, user, db)
    return lst, dashboard, shares, role


def _list_response(lst: List, item_count: int) -> ListResponse:
    return ListResponse(
        id=lst.id,
        dashboard_id=lst.dashboard_id,
        name=lst.name,
        list_type=lst.list_type,
        sort_order=lst.sort_order,
        created_by=lst.created_by,
        created_at=lst.created_at,
        updated_at=lst.updated_at,
        item_count=item_count,
    )


async def _mutated_list_response(db: AsyncSession, lst: List, item_count: int) -> ListResponse:
    await db.refresh(lst)
    return _list_response(lst, item_count)


async def _item_response(db: AsyncSession, item: ListItem) -> ListItemResponse:
    await db.refresh(item)
    return ListItemResponse.model_validate(item)


def _dashboard_managed_permissions_response(dashboard: Dashboard) -> ResourceAccessResponse:
    return ResourceAccessResponse(
        direct_shares=[],
        inherited_dashboards=[InheritedDashboardAccessResponse(dashboard_id=dashboard.id, dashboard_name=dashboard.name)],
    )


def _raise_dashboard_managed_permissions_error() -> None:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="List permissions are managed on the parent dashboard",
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ListResponse)
@limiter.limit(WRITE_LIMIT)
async def create_list(
    request: Request,
    body: ListCreate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListResponse:
    """Create a list on a dashboard the caller can edit."""
    # Lock the parent dashboard row so concurrent creates don't race to pick the
    # same append sort_order (mirrors create_item's per-list lock).
    dashboard, shares, role = await load_dashboard_access(
        body.dashboard_id,
        current_user,
        db,
        lock_for_update=True,
    )
    permissions.assert_can_edit(role)
    await assert_under_quota(
        db,
        model=List,
        resource="lists",
        cap=settings.quota_lists_per_user,
        scope=List.created_by == current_user.id,
        detail=limit_message("lists", settings.quota_lists_per_user, reclaim="purge"),
    )
    await assert_under_quota(
        db,
        model=List,
        resource="lists",
        cap=settings.quota_lists_per_dashboard,
        scope=List.dashboard_id == dashboard.id,
        detail=limit_message("lists on this dashboard", settings.quota_lists_per_dashboard, reclaim="purge"),
    )

    # GET /lists orders all non-deleted lists, so the append position must be
    # computed over that same set to land truly last.
    max_order_result = await db.execute(
        select(func.max(List.sort_order)).where(
            List.dashboard_id == dashboard.id,
            List.deleted_at.is_(None),
        )
    )
    next_order = (max_order_result.scalar_one() or -1) + 1

    lst = List(
        dashboard_id=dashboard.id,
        created_by=current_user.id,
        updated_by=current_user.id,
        name=body.name,
        list_type=body.list_type,
        sort_order=next_order,
    )
    db.add(lst)
    await db.flush()

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_created,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list",
        entity_id=lst.id,
        payload={"name": lst.name, "list_type": str(lst.list_type)},
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    return await _mutated_list_response(db, lst, 0)


@router.get("", response_model=list[ListResponse])
async def list_lists(
    dashboard_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ListResponse]:
    """List accessible lists, optionally filtered to one dashboard."""
    accessible_dashboard_ids = await list_accessible_dashboard_ids(current_user, db)
    if not accessible_dashboard_ids:
        return []

    if dashboard_id is not None and dashboard_id not in accessible_dashboard_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    dashboard_ids = [dashboard_id] if dashboard_id is not None else accessible_dashboard_ids
    result = await db.execute(
        select(List)
        .where(
            List.deleted_at.is_(None),
            List.dashboard_id.in_(dashboard_ids),
        )
        .order_by(List.sort_order, List.created_at)
    )
    lists = list(result.scalars().all())
    if not lists:
        return []

    list_ids = [lst.id for lst in lists]
    counts_result = await db.execute(
        select(ListItem.list_id, func.count(ListItem.id)).where(ListItem.list_id.in_(list_ids)).group_by(ListItem.list_id)
    )
    counts = {row[0]: row[1] for row in counts_result.all()}
    return [_list_response(lst, counts.get(lst.id, 0)) for lst in lists]


@router.put("/order", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def reorder_lists(
    request: Request,
    body: ListReorder,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Atomically renumber a dashboard's live lists to the submitted order."""
    dashboard, shares, role = await load_dashboard_access(body.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    lists_result = await db.execute(
        select(List)
        .where(
            List.dashboard_id == body.dashboard_id,
            List.deleted_at.is_(None),
        )
        .order_by(List.id)
        .with_for_update()
    )
    lists = {lst.id: lst for lst in lists_result.scalars().all()}

    if set(body.list_ids) != set(lists.keys()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Lists changed, please retry")

    for position, list_id in enumerate(body.list_ids):
        lst = lists[list_id]
        lst.sort_order = position
        lst.updated_by = current_user.id

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_reordered,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="dashboard",
        entity_id=body.dashboard_id,
        payload={
            "dashboard_name": dashboard.name,
            "list_ids": [str(i) for i in body.list_ids],
        },
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )


# Declared before /{list_id} so the static segment wins (same pattern as PUT /order).
@router.get("/details", response_model=list[ListDetailResponse])
async def list_list_details(
    dashboard_id: uuid.UUID = Query(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ListDetailResponse]:
    """Every non-deleted list on one dashboard, each with its active items, in one request.

    Exists for the agenda: composing it client-side cost one request per list. Three queries
    total, regardless of how many lists there are.
    """
    # The canonical parent door: read access suffices, and a trashed dashboard hides
    # its child content (404) exactly as the per-list routes do.
    await load_dashboard_access(dashboard_id, current_user, db)

    lists_result = await db.execute(
        select(List).where(List.deleted_at.is_(None), List.dashboard_id == dashboard_id).order_by(List.sort_order, List.created_at)
    )
    lists = list(lists_result.scalars().all())
    if not lists:
        return []

    items_result = await db.execute(
        select(ListItem).where(ListItem.list_id.in_([lst.id for lst in lists])).order_by(ListItem.sort_order, ListItem.created_at)
    )
    items_by_list: dict[uuid.UUID, list[ListItemResponse]] = {lst.id: [] for lst in lists}
    for item in items_result.scalars().all():
        items_by_list[item.list_id].append(ListItemResponse.model_validate(item))

    return [
        ListDetailResponse(
            id=lst.id,
            dashboard_id=lst.dashboard_id,
            name=lst.name,
            list_type=lst.list_type,
            sort_order=lst.sort_order,
            created_by=lst.created_by,
            created_at=lst.created_at,
            updated_at=lst.updated_at,
            item_count=len(items_by_list[lst.id]),
            items=items_by_list[lst.id],
        )
        for lst in lists
    ]


# Declared before GET /{list_id} so the static segment wins (same pattern as /details).
@router.get("/trash", response_model=list[TrashedListSummary])
async def list_trash(
    dashboard_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TrashedListSummary]:
    """Trashed lists on dashboards the caller can see, newest first, with their purge deadline.

    Scoped by dashboard access, not ownership: whoever can edit the dashboard put it there and
    can take it back. Lists under a trashed dashboard are excluded — they return with it.
    """
    accessible_dashboard_ids = await list_accessible_dashboard_ids(current_user, db)
    if not accessible_dashboard_ids:
        return []

    if dashboard_id is not None:
        if dashboard_id not in accessible_dashboard_ids:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
        dashboard_ids = [dashboard_id]
    else:
        dashboard_ids = accessible_dashboard_ids

    result = await db.execute(select(List).where(List.deleted_at.is_not(None), List.dashboard_id.in_(dashboard_ids)).order_by(List.deleted_at.desc()))
    retention = timedelta(days=settings.trash_retention_days)
    summaries: list[TrashedListSummary] = []
    for lst in result.scalars().all():
        # The WHERE guarantees deleted_at; the assert narrows the Optional for the type checker.
        assert lst.deleted_at is not None
        summaries.append(
            TrashedListSummary(
                id=lst.id,
                dashboard_id=lst.dashboard_id,
                name=lst.name,
                list_type=lst.list_type,
                deleted_at=lst.deleted_at,
                purge_at=lst.deleted_at + retention,
            )
        )
    return summaries


@router.post("/{list_id}/restore", response_model=ListResponse)
@limiter.limit(WRITE_LIMIT)
async def restore_list(
    request: Request,
    list_id: uuid.UUID,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListResponse:
    """Bring a trashed list back to its dashboard.

    Widgets unbound on delete are not recreated; the list returns to the sidebar. A list under a
    trashed dashboard cannot be restored alone — restore the dashboard and it comes back with it.
    """
    result = await db.execute(select(List).where(List.id == list_id, List.deleted_at.is_not(None)))
    lst = result.scalar_one_or_none()
    if lst is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    dashboard, shares, role = await load_dashboard_access(lst.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    lst.deleted_at = None
    lst.updated_by = current_user.id

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_created,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list",
        entity_id=lst.id,
        payload={"name": lst.name, "restored": True},
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    count_result = await db.execute(select(func.count(ListItem.id)).where(ListItem.list_id == lst.id))
    return await _mutated_list_response(db, lst, count_result.scalar_one())


@router.delete("/{list_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def purge_trashed_list(
    request: Request,
    list_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a trashed list and its items, ahead of the reaper.

    Needs edit on the live parent dashboard, so a list under a trashed dashboard cannot be purged
    alone — purge the dashboard and it goes with it. Broadcasts nothing; the list is already gone
    from every view but the trash.
    """
    result = await db.execute(select(List).where(List.id == list_id, List.deleted_at.is_not(None)))
    lst = result.scalar_one_or_none()
    if lst is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="List not found")

    _dashboard, _shares, role = await load_dashboard_access(lst.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    await purge_list(db, lst)
    await db.commit()


@router.get("/{list_id}", response_model=ListDetailResponse)
async def get_list(
    list_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListDetailResponse:
    """Return one list with its active items."""
    lst, _dashboard, _shares, _role = await _get_list_access(list_id, current_user, db)
    items_result = await db.execute(select(ListItem).where(ListItem.list_id == list_id).order_by(ListItem.sort_order, ListItem.created_at))
    items = list(items_result.scalars().all())
    return ListDetailResponse(
        id=lst.id,
        dashboard_id=lst.dashboard_id,
        name=lst.name,
        list_type=lst.list_type,
        sort_order=lst.sort_order,
        created_by=lst.created_by,
        created_at=lst.created_at,
        updated_at=lst.updated_at,
        item_count=len(items),
        items=[ListItemResponse.model_validate(item) for item in items],
    )


@router.patch("/{list_id}", response_model=ListResponse)
@limiter.limit(WRITE_LIMIT)
async def update_list(
    request: Request,
    list_id: uuid.UUID,
    body: ListUpdate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListResponse:
    """Update list metadata and broadcast the resulting change."""
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)

    if body.name is not None:
        lst.name = body.name
    lst.updated_by = current_user.id

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_updated,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list",
        entity_id=lst.id,
        payload={"name": lst.name},
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    count_result = await db.execute(select(func.count(ListItem.id)).where(ListItem.list_id == list_id))
    return await _mutated_list_response(db, lst, count_result.scalar_one())


@router.delete("/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_list(
    request: Request,
    list_id: uuid.UUID,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Move a list to the trash, unbinding the widgets that showed it.

    Recoverable via POST /{list_id}/restore until the reaper purges it past
    `trash_retention_days` — the same contract dashboards have (ADR-007).
    """
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)
    await remove_resource_widgets(ResourceType.list.value, lst.id, db)

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_deleted,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list",
        entity_id=lst.id,
        payload={"name": lst.name},
        client_id=client_id,
    )
    lst.deleted_at = datetime.now(UTC)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )


@router.post("/{list_id}/items", status_code=status.HTTP_201_CREATED, response_model=ListItemResponse)
@limiter.limit(WRITE_LIMIT)
async def create_item(
    request: Request,
    list_id: uuid.UUID,
    body: ListItemCreate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListItemResponse:
    """Append a new item to a list in stable sort order."""
    # Serialize append-order assignment within a list so concurrent creates don't pick the same sort_order.
    lst, dashboard, shares, role = await _get_list_access(
        list_id,
        current_user,
        db,
        lock_for_update=True,
    )
    permissions.assert_can_edit(role)
    await assert_under_quota(
        db,
        model=ListItem,
        resource="items",
        cap=settings.quota_items_per_user,
        scope=ListItem.created_by == current_user.id,
        detail=limit_message("list items", settings.quota_items_per_user, reclaim="immediate"),
    )
    await assert_under_quota(
        db,
        model=ListItem,
        resource="items",
        cap=settings.quota_items_per_list,
        scope=ListItem.list_id == list_id,
        detail=limit_message("items on this list", settings.quota_items_per_list, reclaim="immediate"),
    )
    max_order_result = await db.execute(select(func.max(ListItem.sort_order)).where(ListItem.list_id == list_id))
    next_order = (max_order_result.scalar_one() or -1) + 1

    item = ListItem(
        list_id=list_id,
        text=body.text,
        sort_order=next_order,
        due_date=body.due_date,
        priority=body.priority,
        category=body.category,
        assigned_to=body.assigned_to,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(item)
    await db.flush()
    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_item_created,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list_item",
        entity_id=item.id,
        payload={"text": item.text, "list_id": str(list_id), "list_name": lst.name},
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    return await _item_response(db, item)


@router.patch("/{list_id}/items/{item_id}", response_model=ListItemResponse)
@limiter.limit(WRITE_LIMIT)
async def update_item(
    request: Request,
    list_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ListItemUpdate,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListItemResponse:
    """Update fields on a list item the caller can access."""
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    item_result = await db.execute(
        select(ListItem).where(
            ListItem.id == item_id,
            ListItem.list_id == list_id,
        )
    )
    item = item_result.scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")

    permissions.assert_can_edit(role)

    for field in body.model_fields_set:
        setattr(item, field, getattr(body, field))
    item.updated_by = current_user.id

    # Read off the body, not the ORM object: each field is a plain setattr of an already-validated
    # value, and the instance is flush-expired.
    changed_values = body.model_dump(mode="json", include=body.model_fields_set)

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_item_checked if "checked" in body.model_fields_set else EventType.list_item_updated,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list_item",
        entity_id=item.id,
        payload={
            "list_id": str(list_id),
            "list_name": lst.name,
            "text": item.text,
            "fields": list(body.model_fields_set),
            "values": changed_values,
        },
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )
    return await _item_response(db, item)


@router.delete("/{list_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_item(
    request: Request,
    list_id: uuid.UUID,
    item_id: uuid.UUID,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a list item and broadcast the change.

    Items are removed outright rather than tombstoned: an item is a line of text, so recreating one
    costs less than carrying a recovery path nobody can reach ([ADR-007](../../docs/adr/ADR-007-soft-delete-boundary.md)).
    """
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)

    item_result = await db.execute(
        select(ListItem).where(
            ListItem.id == item_id,
            ListItem.list_id == list_id,
        )
    )
    item = item_result.scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_item_deleted,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list_item",
        entity_id=item.id,
        payload={"list_id": str(list_id), "list_name": lst.name, "text": item.text},
        client_id=client_id,
    )
    await db.delete(item)
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )


@router.put("/{list_id}/items/order", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def reorder_items(
    request: Request,
    list_id: uuid.UUID,
    body: ItemReorder,
    client_id: ClientIdHeader = None,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Atomically renumber a list's items to the submitted order."""
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db, lock_for_update=True)
    permissions.assert_can_edit(role)

    items_result = await db.execute(select(ListItem).where(ListItem.list_id == list_id))
    items = {item.id: item for item in items_result.scalars().all()}

    if set(body.item_ids) != set(items.keys()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="List changed, please retry")

    for position, item_id in enumerate(body.item_ids):
        item = items[item_id]
        item.sort_order = position
        item.updated_by = current_user.id

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_item_reordered,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list_item",
        entity_id=list_id,
        payload={
            "list_id": str(list_id),
            "list_name": lst.name,
            "item_ids": [str(i) for i in body.item_ids],
        },
        client_id=client_id,
    )
    await commit_and_broadcast(
        db,
        actor_id=current_user.id,
        fanouts=[_dashboard_fanout(event_message, dashboard, shares)],
    )


@router.get("/{list_id}/shares", response_model=ResourceAccessResponse)
async def list_list_shares(
    list_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResourceAccessResponse:
    """Show that list access is inherited from the parent dashboard."""
    _lst, dashboard, _shares, _role = await _get_list_access(list_id, current_user, db)
    return _dashboard_managed_permissions_response(dashboard)


@router.post("/{list_id}/shares", status_code=status.HTTP_201_CREATED)
@limiter.limit(WRITE_LIMIT)
async def add_list_share(
    request: Request,
    list_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct list sharing because dashboards own permissions."""
    await _get_list_access(list_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.patch("/{list_id}/shares/{share_id}")
@limiter.limit(WRITE_LIMIT)
async def update_list_share(
    request: Request,
    list_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct list share updates because dashboards own permissions."""
    await _get_list_access(list_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.delete("/{list_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(WRITE_LIMIT)
async def delete_list_share(
    request: Request,
    list_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reject direct list share deletion because dashboards own permissions."""
    await _get_list_access(list_id, current_user, db)
    _raise_dashboard_managed_permissions_error()
