import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.list import ItemPriority, ListType
from app.schemas.common import PatchModel


class ListCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    list_type: ListType
    dashboard_id: uuid.UUID


class ListUpdate(PatchModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=200)

    @field_validator("name", mode="before")
    @classmethod
    def _reject_null_updates(cls, value: object) -> object:
        if value is None:
            raise ValueError("List update fields cannot be null")
        return value


class ListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dashboard_id: uuid.UUID
    name: str
    list_type: ListType
    sort_order: int
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    item_count: int


class TrashedListSummary(BaseModel):
    """A list in the trash: enough to recognise it and restore it. Mirrors the dashboard trash."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dashboard_id: uuid.UUID
    name: str
    list_type: ListType
    deleted_at: datetime
    purge_at: datetime


class ListItemCreate(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    due_date: date | None = None
    priority: ItemPriority | None = None
    category: str | None = Field(None, max_length=100)
    assigned_to: uuid.UUID | None = None


class ListItemUpdate(PatchModel):
    text: str | None = Field(None, min_length=1, max_length=2000)
    checked: bool | None = None
    due_date: date | None = None
    priority: ItemPriority | None = None
    category: str | None = Field(None, max_length=100)
    assigned_to: uuid.UUID | None = None


def _reject_duplicate_ids(value: list[uuid.UUID]) -> list[uuid.UUID]:
    if len(set(value)) != len(value):
        raise ValueError("ids must be unique")
    return value


class ItemReorder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)

    _no_dupes = field_validator("item_ids")(_reject_duplicate_ids)


class ListReorder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dashboard_id: uuid.UUID
    list_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)

    _no_dupes = field_validator("list_ids")(_reject_duplicate_ids)


class ListItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    list_id: uuid.UUID
    text: str
    checked: bool
    sort_order: int
    due_date: date | None
    priority: ItemPriority | None
    category: str | None
    assigned_to: uuid.UUID | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class ListDetailResponse(ListResponse):
    items: list[ListItemResponse]
