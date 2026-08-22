"""Re-express every stored layout on the bounded 24x24 grid.

Revision ID: c7e1a9b3d5f8
Revises: b4d6f8h0j2l4
Create Date: 2026-08-19

A coordinate is meaningless without the basis it counts in, so widening the canonical grid has to
rewrite every stored item or every existing board renders at half size. Columns doubled 12 -> 24,
and doubling `x`/`w` is exactly size-preserving: a span of n cells measures `n*cell + (n-1)*margin`
and cell width is itself derived from the count, so the margin terms cancel.

Rows are the harder half. Nothing bounded them before — the client sized rows so eleven filled the
viewport, but a board could be any height — and they are now a hard bound like columns. So `y`/`h`
double to match the new density and are then **compacted** into the 24 rows available: items are
packed upward in their existing order, and anything that still cannot fit is clamped to the last
row rather than dropped. That is lossy for a board taller than one screen, and deliberately so;
the alternative is a widget parked where the user can never reach it (ADR-009).

Items missing a key, or holding a non-number in one, are left alone rather than coerced: reads are
deliberately unvalidated (see `LayoutItem`) so such a row can exist, and halving a string is a worse
outcome than an odd-looking widget. The row filter tests only the layout's type for the same reason
it is not also a length test — Postgres does not promise to short-circuit `AND`, so pairing it with
`jsonb_array_length` aborts the whole statement on the legacy `{"rows": []}` default.
"""

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "c7e1a9b3d5f8"
down_revision: str | Sequence[str] | None = "b4d6f8h0j2l4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GRID_COLUMNS = 24
GRID_ROWS = 24
_KEYS = ("x", "y", "w", "h")


def _scalable(item: Any) -> bool:
    return isinstance(item, dict) and all(
        isinstance(item.get(key), int) and not isinstance(item.get(key), bool) for key in _KEYS
    )


def _seat(
    placed: list[tuple[int, int, int, int]], w: int, h: int, columns: int, rows: int
) -> tuple[int, int] | None:
    """First free position for a `w`x`h` box, scanning the occupied edges, or None if it cannot fit."""
    candidate_rows = sorted({0} | {y + box_h for _, y, _, box_h in placed})
    candidate_cols = sorted({0} | {x + box_w for x, _, box_w, _ in placed})
    for y in candidate_rows:
        if y + h > rows:
            continue
        for x in candidate_cols:
            if x + w > columns:
                continue
            if all(
                x >= box_x + box_w or box_x >= x + w or y >= box_y + box_h or box_y >= y + h
                for box_x, box_y, box_w, box_h in placed
            ):
                return (x, y)
    return None


def rescale(layout: Any, factor: int, columns: int, rows: int) -> Any:
    """Re-express a layout on a `columns` x `rows` grid, scaling by at most `factor`.

    Exposed rather than private so the migration's own arithmetic is what the tests exercise.

    Columns doubled exactly, so `x`/`w` always take the full factor. Rows did not: they were
    unbounded, and a board taller than half the new grid cannot take the factor without spilling
    out of it. Such a board is scaled by whatever *does* fit instead, which preserves the
    arrangement — every widget keeps its share of the board — where clamping each item alone would
    silently stack them all on the last rows.
    """
    if not isinstance(layout, list):
        return layout

    items = [item for item in layout if _scalable(item)]
    extent = max((item["y"] + item["h"] for item in items), default=0)
    vertical = min(factor, rows / extent) if extent else factor

    scaled: list[Any] = []
    for item in layout:
        if not _scalable(item):
            scaled.append(item)
            continue
        scaled.append(
            {
                **item,
                "x": min(item["x"] * factor, columns - 1),
                "y": int(item["y"] * vertical),
                "w": max(1, min(item["w"] * factor, columns)),
                "h": max(1, min(int(item["h"] * vertical), rows)),
            }
        )

    # Seat rather than clamp: clamping satisfies the bounds while leaving an overlap, and overlap is
    # now an invariant the write path enforces — so that would store what the API itself rejects.
    placed: list[tuple[int, int, int, int]] = []
    for item in sorted(
        (entry for entry in scaled if _scalable(entry)),
        key=lambda entry: (entry["y"], entry["x"]),
    ):
        # Settling in place first is what preserves the arrangement: keep the column, and rise to
        # rest on whatever is already there — the same thing the client's vertical compactor does
        # on every render. Relocating is the fallback, not the rule.
        x = max(0, min(item["x"], columns - item["w"]))
        top = max(
            (box_y + box_h for box_x, box_y, box_w, box_h in placed if x < box_x + box_w and box_x < x + item["w"]),
            default=0,
        )
        seat: tuple[int, int] | None = (x, top) if top + item["h"] <= rows else None
        if seat is None:
            seat = _seat(placed, item["w"], item["h"], columns, rows)
        # Nothing holds it at that size, so it gives up area rather than sitting on a neighbour.
        # A 1x1 always fits: the grid has far more cells than the widget quota allows widgets.
        while seat is None and (item["w"] > 1 or item["h"] > 1):
            if item["h"] >= item["w"]:
                item["h"] -= 1
            else:
                item["w"] -= 1
            seat = _seat(placed, item["w"], item["h"], columns, rows)
        item["x"], item["y"] = seat if seat else (0, 0)
        placed.append((item["x"], item["y"], item["w"], item["h"]))

    return scaled


def _rewrite(connection: sa.Connection, factor: int) -> None:
    rows = connection.execute(sa.text("SELECT id, layout FROM dashboards")).mappings().all()
    for row in rows:
        rescaled = rescale(row["layout"], factor, GRID_COLUMNS, GRID_ROWS)
        if rescaled == row["layout"]:
            continue
        connection.execute(
            sa.text("UPDATE dashboards SET layout = CAST(:layout AS jsonb) WHERE id = :id"),
            {"layout": json.dumps(rescaled), "id": row["id"]},
        )


def upgrade() -> None:
    _rewrite(op.get_bind(), 2)


def downgrade() -> None:
    # Lossy by nature: the wider grid holds arrangements the narrower one cannot express, and the
    # packing above is not reversible. Halving restores the common case and keeps everything inside
    # the old bounds, which is what the previous write path will accept.
    connection = op.get_bind()
    result = connection.execute(sa.text("SELECT id, layout FROM dashboards")).mappings().all()
    for row in result:
        layout = row["layout"]
        if not isinstance(layout, list):
            continue
        halved = [
            {
                **item,
                "x": item["x"] // 2,
                "y": item["y"] // 2,
                "w": max(1, item["w"] // 2),
                "h": max(1, item["h"] // 2),
            }
            if _scalable(item)
            else item
            for item in layout
        ]
        connection.execute(
            sa.text("UPDATE dashboards SET layout = CAST(:layout AS jsonb) WHERE id = :id"),
            {"layout": json.dumps(halved), "id": row["id"]},
        )
