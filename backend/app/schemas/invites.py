import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class InviteCreate(BaseModel):
    expires_in_days: int = Field(7, ge=1, le=30)
    max_uses: int = Field(10, ge=1, le=100)


class InviteResponse(BaseModel):
    id: uuid.UUID
    code: str
    expires_at: datetime
    max_uses: int
    use_count: int
    revoked: bool
    created_at: datetime

    model_config = {"from_attributes": True}
