import uuid
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard, DashboardWidget


async def remove_resource_widgets(
    resource_type: str,
    resource_id: uuid.UUID,
    db: AsyncSession,
) -> dict[uuid.UUID, list[str]]:
    result = await db.execute(
        select(DashboardWidget).where(
            DashboardWidget.resource_type == resource_type,
            DashboardWidget.resource_id == resource_id,
        )
    )
    widgets = list(result.scalars().all())
    if not widgets:
        return {}

    widget_ids_by_dashboard: dict[uuid.UUID, list[str]] = defaultdict(list)
    for widget in widgets:
        widget_ids_by_dashboard[widget.dashboard_id].append(str(widget.id))

    dashboards_result = await db.execute(select(Dashboard).where(Dashboard.id.in_(widget_ids_by_dashboard.keys())))
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
