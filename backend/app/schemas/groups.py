import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class GroupUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)


class GroupResponse(BaseModel):
    id: uuid.UUID
    name: str
    created_by: uuid.UUID
    settings: dict
    created_at: datetime
    member_count: int


class MemberResponse(BaseModel):
    user_id: uuid.UUID
    display_name: str
    email: str
    role: str
    dashboard_role: str
    joined_at: datetime


class MemberRoleUpdate(BaseModel):
    role: Literal["owner", "admin", "member"] | None = None
    dashboard_role: Literal["viewer", "editor"] | None = None
