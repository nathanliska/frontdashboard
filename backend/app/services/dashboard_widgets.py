import uuid
from collections import defaultdict
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard, DashboardWidget
from app.models.list import List, ListType
from app.models.user import User
from app.schemas.dashboards import GRID_COLUMNS, GRID_ROWS, MIN_WIDGET_HEIGHT, MIN_WIDGET_WIDTH


async def remove_list_widgets(list_id: uuid.UUID, db: AsyncSession) -> dict[uuid.UUID, list[str]]:
    result = await db.execute(select(DashboardWidget).where(DashboardWidget.list_id == list_id))
    widgets = list(result.scalars().all())
    if not widgets:
        return {}

    widget_ids_by_dashboard: dict[uuid.UUID, list[str]] = defaultdict(list)
    for widget in widgets:
        widget_ids_by_dashboard[widget.dashboard_id].append(str(widget.id))

    dashboards_result = await db.execute(
        select(Dashboard).where(Dashboard.id.in_(widget_ids_by_dashboard.keys())).order_by(Dashboard.id.asc()).with_for_update()
    )
    dashboards = {dashboard.id: dashboard for dashboard in dashboards_result.scalars().all()}

    for dashboard_id, widget_ids in widget_ids_by_dashboard.items():
        dashboard = dashboards.get(dashboard_id)
        if dashboard is None:
            continue

        current_layout = dashboard.layout if isinstance(dashboard.layout, list) else []
        widget_id_set = set(widget_ids)
        next_layout = [item for item in current_layout if str(item.get("i")) not in widget_id_set]
        if next_layout != current_layout:
            dashboard.layout = next_layout
        dashboard.version += 1

    for widget in widgets:
        await db.delete(widget)

    return dict(widget_ids_by_dashboard)


def first_free_slot(layout: list[dict[str, Any]], w: int, h: int) -> tuple[int, int] | None:
    """Topmost-then-leftmost free position for a `w`x`h` widget, or None when the board is full.

    Candidates are the existing edges rather than every cell: a slot that fits at all fits flush
    against something's bottom or right, or against an axis. That keeps the scan quadratic in the
    widget count rather than proportional to the grid's area.

    There is no below-everything fallback, because there is no below — the grid is bounded on both
    axes, and a widget placed past the last row could not be reached at all (ADR-009).
    """
    boxes = [(item.get("x", 0), item.get("y", 0), item.get("w", 1), item.get("h", 1)) for item in layout]
    rows = sorted({0} | {y + box_h for _, y, _, box_h in boxes})
    columns = sorted({0} | {x + box_w for x, _, box_w, _ in boxes})

    for y in rows:
        if y + h > GRID_ROWS:
            continue
        for x in columns:
            if x + w > GRID_COLUMNS:
                continue
            overlaps = any(x < box_x + box_w and box_x < x + w and y < box_y + box_h and box_y < y + h for box_x, box_y, box_w, box_h in boxes)
            if not overlaps:
                return (x, y)
    return None


def fit_widget(
    layout: list[dict[str, Any]], w: int, h: int, *, minimum: tuple[int, int] = (MIN_WIDGET_WIDTH, MIN_WIDGET_HEIGHT)
) -> tuple[int, int, int, int] | None:
    """Seat the largest useful box up to `w`x`h`, or None when no useful box fits.

    The default size is a preference, not a requirement. Asking only for that exact box reports a
    full board while an eighth of the grid stands empty — a gap one row short of the default is
    ordinary. Shrinking stops at the widget's minimum, since a box that hides its content is not
    usable space.

    Candidates are tried largest-area first, so a widget gives up only the area it has to, and ties
    go to the shape the default asked for. The first candidate *is* the default, so a board with
    room pays a single scan.
    """
    shape = w / h
    candidates = sorted(
        ((width, height) for width in range(minimum[0], w + 1) for height in range(minimum[1], h + 1)),
        key=lambda size: (-size[0] * size[1], abs(size[0] / size[1] - shape)),
    )

    for width, height in candidates:
        slot = first_free_slot(layout, width, height)
        if slot is not None:
            return (*slot, width, height)
    return None


def default_widget_size(widget_type: str) -> tuple[int, int]:
    """Starting size for a new widget, in canonical grid cells.

    The calendar is the largest because it is the one widget rendering a grid of its own — a month
    is seven day columns by five weeks — so it needs the room the others do not. Everything else
    starts small enough to read at a glance and be dragged bigger.

    Both divide 24 exactly, which is what keeps a board tiling rather than going ragged: a height of
    9 leaves 24 // 9 == 2 rows of widgets and wastes the remainder, costing three full-size slots.

    The widgets' own size thresholds are pixels tuned against these defaults, and nothing links the
    two: change a size here and re-check them, or a default-sized widget can hide its own controls.
    """
    if widget_type == "calendar":
        return (12, 8)
    return (4, 6)


async def bind_list_widget(
    db: AsyncSession,
    *,
    dashboard: Dashboard,
    current_user: User,
    list_id: uuid.UUID | None,
    widget_config: dict[str, Any],
) -> tuple[uuid.UUID, List | None, dict[str, Any]]:
    """Resolve the list a new list widget binds, creating one when none is named.

    Returns the list id, the list if it was created here, and the config to store. Raises 422 for
    an unknown list type, 404 for a list not on this dashboard, and 409 when the list already has
    a widget here.
    """
    created_list: List | None = None
    if list_id is None:
        list_name = str(widget_config.get("name") or "").strip() or "Untitled List"
        raw_list_type = str(widget_config.get("list_type") or "checklist")
        try:
            list_type = ListType(raw_list_type)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Invalid list type",
            ) from exc

        # Computed over the same set GET /lists orders, or the append doesn't land last.
        max_order_result = await db.execute(
            select(func.max(List.sort_order)).where(
                List.dashboard_id == dashboard.id,
                List.deleted_at.is_(None),
            )
        )
        next_order = (max_order_result.scalar_one() or -1) + 1

        created_list = List(
            dashboard_id=dashboard.id,
            created_by=current_user.id,
            updated_by=current_user.id,
            name=list_name,
            list_type=list_type,
            sort_order=next_order,
        )
        db.add(created_list)
        await db.flush()
        list_id = created_list.id
        widget_config = {
            **widget_config,
            "list_name": list_name,
            "list_type": list_type.value,
        }
        widget_config.pop("name", None)
    else:
        list_result = await db.execute(
            select(List).where(
                List.id == list_id,
                List.dashboard_id == dashboard.id,
                List.deleted_at.is_(None),
            )
        )
        existing_list = list_result.scalar_one_or_none()
        if existing_list is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="List not found on this dashboard",
            )

    # One list maps to at most one widget per dashboard. The unique index enforces it; this
    # check exists for the friendly 409.
    existing_widget_result = await db.execute(
        select(DashboardWidget).where(
            DashboardWidget.dashboard_id == dashboard.id,
            DashboardWidget.list_id == list_id,
        )
    )
    if existing_widget_result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That item is already on this dashboard",
        )
    return list_id, created_list, widget_config
