from dataclasses import dataclass
from enum import StrEnum

from fastapi import HTTPException, status

from app.models.share import ResourceType


class WidgetContentMode(StrEnum):
    static = "static"
    resource = "resource"
    dashboard_query = "dashboard_query"


@dataclass(frozen=True)
class WidgetPolicy:
    widget_type: str
    content_mode: WidgetContentMode
    resource_type: ResourceType | None = None


WIDGET_POLICIES: dict[str, WidgetPolicy] = {
    "calendar": WidgetPolicy(
        widget_type="calendar",
        content_mode=WidgetContentMode.dashboard_query,
    ),
    "agenda": WidgetPolicy(
        widget_type="agenda",
        content_mode=WidgetContentMode.dashboard_query,
    ),
    "list": WidgetPolicy(
        widget_type="list",
        content_mode=WidgetContentMode.resource,
        resource_type=ResourceType.list,
    ),
    "clock": WidgetPolicy(
        widget_type="clock",
        content_mode=WidgetContentMode.static,
    ),
}


def get_widget_policy(widget_type: str) -> WidgetPolicy:
    policy = WIDGET_POLICIES.get(widget_type)
    if policy is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown widget type: {widget_type}",
        )
    return policy
