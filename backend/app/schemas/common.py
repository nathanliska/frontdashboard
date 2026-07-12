from typing import Self

from pydantic import BaseModel, model_validator


class PatchModel(BaseModel):
    """Base for PATCH bodies: reject an empty patch (no fields set) with a 422."""

    @model_validator(mode="after")
    def _reject_empty_patch(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self
