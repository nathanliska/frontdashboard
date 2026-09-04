"""The grid is one basis, declared twice — and nothing but this links the two.

`GRID_COLUMNS` and `GRID_ROWS` bound the write path: `PUT /layout` rejects an item reaching past
either edge. The grid the client renders in decides what coordinates a gesture can produce. They
are module constants and TSX literals, so the generated contract cannot carry the numbers and no
type checks them — drift shows up as every gesture near an edge failing with a 422, far from the
edit that caused it.

Changing either is a migration, not a config change: a coordinate is meaningless without the basis
it counts in, so a change here has to rewrite every stored layout (ADR-009).
"""

import pytest

from app.schemas.dashboards import GRID_COLUMNS, GRID_ROWS
from tests.conventions import DASHBOARD_GRID, declared_int

_AXES = [("DESKTOP_COLUMNS", GRID_COLUMNS), ("DESKTOP_ROWS", GRID_ROWS)]


@pytest.mark.parametrize(("constant", "expected"), _AXES)
def test_frontend_renders_the_grid_the_backend_validates(constant: str, expected: int) -> None:
    found = declared_int(DASHBOARD_GRID, constant)

    assert found == expected, (
        f"{DASHBOARD_GRID.name} renders {found} for {constant} but the write path validates against "
        f"{expected} — a gesture past that edge would save as a 422. Change both, and migrate every "
        "stored layout, since a coordinate is meaningless without its basis"
    )
