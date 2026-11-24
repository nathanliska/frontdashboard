"""The zone names a client may store, for every field that takes one."""

from importlib.resources import files
from typing import Annotated

import tzdata
from pydantic import AfterValidator, StringConstraints

# The tzdata package's list rather than the host's, so every OS gives the same answer, and every
# name on it loads: zoneinfo falls back to that package. `Factory` is a placeholder browsers reject.
_ZONES = frozenset(files(tzdata).joinpath("zones").read_text(encoding="utf-8").split()) - {"Factory"}


def _known_zone(name: str) -> str:
    if name not in _ZONES:
        raise ValueError("timezone must be a valid IANA timezone")
    return name


TimeZoneName = Annotated[str, StringConstraints(min_length=1, max_length=100), AfterValidator(_known_zone)]
