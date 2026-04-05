import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.list import ItemPriority, ListType


class ListCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    list_type: ListType
    dashboard_id: uuid.UUID


class ListUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    archived: bool | None = None


class ListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dashboard_id: uuid.UUID
    name: str
    list_type: ListType
    archived: bool
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    item_count: int


class ListItemCreate(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    due_date: date | None = None
    priority: ItemPriority | None = None
    category: str | None = Field(None, max_length=100)
    assigned_to: uuid.UUID | None = None


class ListItemUpdate(BaseModel):
    text: str | None = Field(None, min_length=1, max_length=2000)
    checked: bool | None = None
    sort_order: int | None = None
    due_date: date | None = None
    priority: ItemPriority | None = None
    category: str | None = Field(None, max_length=100)
    assigned_to: uuid.UUID | None = None


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
