"""The migration that re-expresses every stored layout on the bounded 24x24 grid.

A coordinate is meaningless without the basis it counts in, so changing the grid is a data rewrite
rather than a config change — and this is the only thing standing between that rewrite and every
existing board rendering at half size. The arithmetic under test is imported from the migration
itself, not restated, so a fix there is covered here by construction.

Rows are the interesting half: nothing bounded them before, so a stored board can be taller than
the grid now allows and has to be packed into it.
"""

import importlib.util
from pathlib import Path
from typing import Any

import pytest

from app.schemas.dashboards import GRID_COLUMNS, GRID_ROWS, LayoutUpdate

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "c7e1a9b3d5f8_double_layout_grid_resolution.py"


def _load_migration() -> Any:
    spec = importlib.util.spec_from_file_location("_layout_rescale", _MIGRATION)
    assert spec and spec.loader, f"cannot import {_MIGRATION}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_migration = _load_migration()


def upgrade(layout: Any) -> Any:
    return _migration.rescale(layout, 2, GRID_COLUMNS, GRID_ROWS)


def test_the_migration_and_the_schema_agree_on_the_grid() -> None:
    # Two copies of the same two numbers, and the migration cannot import the schema without
    # pinning itself to today's version of it. This is what catches them diverging.
    assert (_migration.GRID_COLUMNS, _migration.GRID_ROWS) == (GRID_COLUMNS, GRID_ROWS)


def test_every_coordinate_doubles() -> None:
    # Stacked in one column, so packing has nothing to close and the doubling is visible directly.
    layout = [
        {"i": "a", "x": 0, "y": 0, "w": 4, "h": 3},
        {"i": "b", "x": 0, "y": 3, "w": 4, "h": 5},
    ]

    assert upgrade(layout) == [
        {"i": "a", "x": 0, "y": 0, "w": 8, "h": 6},
        {"i": "b", "x": 0, "y": 6, "w": 8, "h": 10},
    ]


def test_item_order_survives_the_rewrite() -> None:
    # The layout array's order is the paint order react-grid-layout renders in — losing it
    # reshuffles which widget draws on top. Packing sorts internally, so this is a real risk.
    layout = [{"i": chr(97 + n), "x": n, "y": 0, "w": 1, "h": 1} for n in range(12)]

    assert [item["i"] for item in upgrade(layout)] == [item["i"] for item in layout]


def test_a_board_taller_than_the_grid_is_packed_into_it() -> None:
    # Nothing bounded rows before, so this is the shape the migration exists for. Stacked 8-row
    # widgets doubled to 16 would reach row 48; they have to come back inside 24.
    layout = [{"i": f"w{n}", "x": 0, "y": n * 8, "w": 4, "h": 8} for n in range(3)]

    packed = upgrade(layout)

    assert all(item["y"] + item["h"] <= GRID_ROWS for item in packed)
    assert LayoutUpdate(layout=packed, version=0).layout  # the write path accepts the result


def test_packing_keeps_widgets_from_overlapping() -> None:
    # Clamping each item independently would satisfy the bound and silently stack three widgets on
    # the same rows. Packing is what makes the result a layout rather than merely a legal one.
    layout = [{"i": f"w{n}", "x": 0, "y": n * 8, "w": 4, "h": 8} for n in range(3)]

    packed = sorted(upgrade(layout), key=lambda item: item["y"])

    for above, below in zip(packed, packed[1:], strict=False):
        assert above["y"] + above["h"] <= below["y"]


def test_a_board_that_fits_keeps_its_arrangement_side_by_side() -> None:
    # Side-by-side stays side by side, at double the size. The rows close up to the top because the
    # client's vertical compactor already does that on every render — storing the settled form is
    # what the user was being shown, not a rearrangement.
    layout = [
        {"i": "a", "x": 0, "y": 2, "w": 4, "h": 4},
        {"i": "b", "x": 4, "y": 2, "w": 4, "h": 4},
    ]

    assert upgrade(layout) == [
        {"i": "a", "x": 0, "y": 0, "w": 8, "h": 8},
        {"i": "b", "x": 8, "y": 0, "w": 8, "h": 8},
    ]


def test_a_tall_board_is_scaled_by_what_fits_rather_than_clamped() -> None:
    # Three 8-row widgets reach row 24 already, so doubling would need 48. Scaling by 1 instead
    # keeps all three at their share of the board; clamping each alone would stack them.
    layout = [{"i": f"w{n}", "x": 0, "y": n * 8, "w": 4, "h": 8} for n in range(3)]

    packed = upgrade(layout)

    assert [item["h"] for item in packed] == [8, 8, 8]
    assert [item["y"] for item in packed] == [0, 8, 16]
    # Columns still take the full factor — only rows were constrained.
    assert all(item["w"] == 8 for item in packed)


def test_a_stored_overlap_is_packed_apart() -> None:
    # Overlap was accepted before this release, so rows like this are already stored — the repair
    # path, not a hypothetical. 12-column coordinates, which is what this migration reads.
    layout = [
        {"i": "a", "x": 0, "y": 1, "w": 3, "h": 5},
        {"i": "b", "x": 2, "y": 0, "w": 9, "h": 10},
    ]

    packed = upgrade(layout)

    assert not any(
        one is not two
        and one["x"] < two["x"] + two["w"]
        and two["x"] < one["x"] + one["w"]
        and one["y"] < two["y"] + two["h"]
        and two["y"] < one["y"] + one["h"]
        for one in packed
        for two in packed
    )
    # And the result is one the hardened write path will now accept.
    assert LayoutUpdate(layout=packed, version=0).layout


def test_a_widget_wider_than_the_grid_is_clamped_inside_it() -> None:
    assert upgrade([{"i": "a", "x": 0, "y": 0, "w": 20, "h": 2}]) == [{"i": "a", "x": 0, "y": 0, "w": GRID_COLUMNS, "h": 4}]


@pytest.mark.parametrize(
    "item",
    [
        pytest.param({"i": "a", "x": 0, "y": 0, "w": 4}, id="missing-a-key"),
        pytest.param({"i": "a", "x": "0", "y": 0, "w": 4, "h": 3}, id="string-coordinate"),
        pytest.param({"i": "a", "x": None, "y": 0, "w": 4, "h": 3}, id="null-coordinate"),
        pytest.param({"i": "a", "x": True, "y": 0, "w": 4, "h": 3}, id="bool-is-not-a-coordinate"),
    ],
)
def test_unscalable_items_pass_through_untouched(item: dict[str, Any]) -> None:
    # Reads are deliberately unvalidated (see LayoutItem), so these rows can exist. Coercing one
    # would fail the whole statement and roll back every dashboard's rewrite with it.
    assert upgrade([item]) == [item]


@pytest.mark.parametrize(
    "layout",
    [pytest.param([], id="empty-array"), pytest.param({"rows": []}, id="legacy-object")],
)
def test_layouts_with_nothing_to_rescale_are_left_alone(layout: Any) -> None:
    # The original schema defaulted this column to '{"rows": []}', so a never-touched row can still
    # hold an object rather than an array.
    assert upgrade(layout) == layout
