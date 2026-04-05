import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_csrf
from app.database import get_db
from app.models.dashboard import Dashboard
from app.models.list import List, ListItem
from app.models.share import ResourceShare, ResourceType, ShareRole
from app.models.user import User
from app.schemas.lists import (
    ListCreate,
    ListDetailResponse,
    ListItemCreate,
    ListItemResponse,
    ListItemUpdate,
    ListResponse,
    ListUpdate,
)
from app.schemas.shares import ResourceAccessResponse
from app.services import permissions
from app.services.activity import EventType, log_event
from app.services.dashboard_widgets import remove_resource_widgets
from app.services.shares import (
    cleanup_resource_shares,
    list_accessible_dashboard_ids,
    load_dashboard_access,
)
from app.sse.events import build_activity_sse_dict
from app.sse.manager import manager

router = APIRouter(prefix="/api/lists", tags=["lists"])


def _dashboard_user_ids(
    dashboard: Dashboard,
    shares: list[ResourceShare],
) -> set[uuid.UUID]:
    user_ids: set[uuid.UUID] = {dashboard.user_id}
    user_ids.update(share.principal_id for share in shares)
    return user_ids


async def _broadcast_dashboard_event(
    message: dict,
    dashboard: Dashboard,
    shares: list[ResourceShare],
    actor_id: uuid.UUID,
) -> None:
    await manager.broadcast(
        message,
        group_id=None,
        user_ids=_dashboard_user_ids(dashboard, shares),
        actor_id=actor_id,
    )


async def _get_list_access(
    list_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[List, Dashboard, list[ResourceShare], ShareRole | None]:
    result = await db.execute(select(List).where(List.id == list_id, List.deleted_at.is_(None)))
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
        archived=lst.archived,
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
        inherited_dashboards=[
            {
                "dashboard_id": dashboard.id,
                "dashboard_name": dashboard.name,
            }
        ],
    )


def _raise_dashboard_managed_permissions_error() -> None:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="List permissions are managed on the parent dashboard",
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ListResponse)
async def create_list(
    body: ListCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListResponse:
    dashboard, shares, role = await load_dashboard_access(body.dashboard_id, current_user, db)
    permissions.assert_can_edit(role)

    lst = List(
        dashboard_id=dashboard.id,
        created_by=current_user.id,
        updated_by=current_user.id,
        name=body.name,
        list_type=body.list_type,
    )
    db.add(lst)
    await db.flush()

    event = log_event(
        db,
        event_type=EventType.list_created,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="list",
        entity_id=lst.id,
        group_id=None,
        payload={"name": lst.name, "list_type": str(lst.list_type), "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, event)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
    return await _mutated_list_response(db, lst, 0)


@router.get("", response_model=list[ListResponse])
async def list_lists(
    dashboard_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ListResponse]:
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
        select(ListItem.list_id, func.count(ListItem.id))
        .where(ListItem.list_id.in_(list_ids), ListItem.deleted_at.is_(None))
        .group_by(ListItem.list_id)
    )
    counts = {row[0]: row[1] for row in counts_result.all()}
    return [_list_response(lst, counts.get(lst.id, 0)) for lst in lists]


@router.get("/{list_id}", response_model=ListDetailResponse)
async def get_list(
    list_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListDetailResponse:
    lst, _dashboard, _shares, _role = await _get_list_access(list_id, current_user, db)
    items_result = await db.execute(
        select(ListItem).where(ListItem.list_id == list_id, ListItem.deleted_at.is_(None)).order_by(ListItem.sort_order, ListItem.created_at)
    )
    items = list(items_result.scalars().all())
    return ListDetailResponse(
        id=lst.id,
        dashboard_id=lst.dashboard_id,
        name=lst.name,
        list_type=lst.list_type,
        archived=lst.archived,
        created_by=lst.created_by,
        created_at=lst.created_at,
        updated_at=lst.updated_at,
        item_count=len(items),
        items=[ListItemResponse.model_validate(item) for item in items],
    )


@router.patch("/{list_id}", response_model=ListResponse)
async def update_list(
    list_id: uuid.UUID,
    body: ListUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListResponse:
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)

    if body.name is not None:
        lst.name = body.name
    if body.archived is not None:
        lst.archived = body.archived
    lst.updated_by = current_user.id

    event = log_event(
        db,
        event_type=EventType.list_archived if body.archived is not None else EventType.list_updated,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="list",
        entity_id=lst.id,
        group_id=None,
        payload={"name": lst.name, "archived": lst.archived, "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, event)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
    count_result = await db.execute(select(func.count(ListItem.id)).where(ListItem.list_id == list_id, ListItem.deleted_at.is_(None)))
    return await _mutated_list_response(db, lst, count_result.scalar_one())


@router.delete("/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_list(
    list_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)
    await remove_resource_widgets(ResourceType.list.value, lst.id, db)

    event = log_event(
        db,
        event_type=EventType.list_deleted,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="list",
        entity_id=lst.id,
        group_id=None,
        payload={"name": lst.name, "dashboard_id": str(dashboard.id)},
    )
    lst.deleted_at = datetime.now(UTC)
    event_message = await build_activity_sse_dict(db, event)
    await cleanup_resource_shares(ResourceType.list, lst.id, db)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)


@router.post("/{list_id}/items", status_code=status.HTTP_201_CREATED, response_model=ListItemResponse)
async def create_item(
    list_id: uuid.UUID,
    body: ListItemCreate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListItemResponse:
    lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)
    if lst.archived:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot add items to an archived list")

    max_order_result = await db.execute(select(func.max(ListItem.sort_order)).where(ListItem.list_id == list_id, ListItem.deleted_at.is_(None)))
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
    event = log_event(
        db,
        event_type=EventType.list_item_created,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="list_item",
        entity_id=item.id,
        group_id=None,
        payload={"text": item.text, "list_id": str(list_id), "dashboard_id": str(dashboard.id)},
    )
    event_message = await build_activity_sse_dict(db, event)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
    return await _item_response(db, item)


@router.patch("/{list_id}/items/{item_id}", response_model=ListItemResponse)
async def update_item(
    list_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ListItemUpdate,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ListItemResponse:
    _lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    item_result = await db.execute(
        select(ListItem).where(
            ListItem.id == item_id,
            ListItem.list_id == list_id,
            ListItem.deleted_at.is_(None),
        )
    )
    item = item_result.scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")

    if body.model_fields_set:
        permissions.assert_can_edit(role)

    for field in body.model_fields_set:
        setattr(item, field, getattr(body, field))
    item.updated_by = current_user.id

    event = log_event(
        db,
        event_type=EventType.list_item_checked if "checked" in body.model_fields_set else EventType.list_item_updated,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="list_item",
        entity_id=item.id,
        group_id=None,
        payload={"list_id": str(list_id), "dashboard_id": str(dashboard.id), "fields": list(body.model_fields_set)},
    )
    event_message = await build_activity_sse_dict(db, event)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)
    return await _item_response(db, item)


@router.delete("/{list_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    list_id: uuid.UUID,
    item_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    _lst, dashboard, shares, role = await _get_list_access(list_id, current_user, db)
    permissions.assert_can_edit(role)

    item_result = await db.execute(
        select(ListItem).where(
            ListItem.id == item_id,
            ListItem.list_id == list_id,
            ListItem.deleted_at.is_(None),
        )
    )
    item = item_result.scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")

    event = log_event(
        db,
        event_type=EventType.list_item_deleted,
        actor_id=current_user.id,
        actor_display_name=current_user.display_name,
        entity_type="list_item",
        entity_id=item.id,
        group_id=None,
        payload={"list_id": str(list_id), "dashboard_id": str(dashboard.id)},
    )
    item.deleted_at = datetime.now(UTC)
    event_message = await build_activity_sse_dict(db, event)
    await db.commit()
    await _broadcast_dashboard_event(event_message, dashboard, shares, current_user.id)


@router.get("/{list_id}/shares", response_model=ResourceAccessResponse)
async def list_list_shares(
    list_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResourceAccessResponse:
    _lst, dashboard, _shares, _role = await _get_list_access(list_id, current_user, db)
    return _dashboard_managed_permissions_response(dashboard)


@router.post("/{list_id}/shares", status_code=status.HTTP_201_CREATED)
async def add_list_share(
    list_id: uuid.UUID,
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _get_list_access(list_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.patch("/{list_id}/shares/{share_id}")
async def update_list_share(
    list_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _get_list_access(list_id, current_user, db)
    _raise_dashboard_managed_permissions_error()


@router.delete("/{list_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_list_share(
    list_id: uuid.UUID,
    share_id: uuid.UUID,  # noqa: ARG001
    _csrf: None = Depends(require_csrf),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _get_list_access(list_id, current_user, db)
    _raise_dashboard_managed_permissions_error()
