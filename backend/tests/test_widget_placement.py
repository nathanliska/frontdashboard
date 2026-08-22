"""Where a newly added widget lands.

Placement is the server's, not the client's, and the grid is bounded on both axes — so there is no
below-everything to fall back to. A slot either exists inside the grid or the board is full, and
inventing one past the last row would put a widget where nobody can reach it (ADR-009).
"""

import pytest

from app.routers.dashboards import _first_free_slot, _fit_widget
from app.schemas.dashboards import GRID_COLUMNS, GRID_ROWS


def _item(x: int, y: int, w: int, h: int, name: str = "w") -> dict[str, int | str]:
    return {"i": name, "x": x, "y": y, "w": w, "h": h}


def test_first_widget_takes_the_origin() -> None:
    assert _first_free_slot([], 8, 8) == (0, 0)


def test_second_widget_lands_beside_the_first_rather_than_below_it() -> None:
    # The whole point of the change: a board fills sideways while there is room, so a dashboard of
    # many widgets is a grid rather than one tall column.
    assert _first_free_slot([_item(0, 0, 8, 8)], 8, 8) == (8, 0)


def test_a_row_wraps_once_the_grid_runs_out_of_columns() -> None:
    full_row = [_item(x, 0, 8, 8, f"w{x}") for x in range(0, GRID_COLUMNS, 8)]

    assert _first_free_slot(full_row, 8, 8) == (0, 8)


def test_a_gap_left_by_a_removed_widget_is_reused() -> None:
    # Edges are the only candidates considered, so a hole flush against two of them has to be
    # found — otherwise the scan is just "below everything" wearing a costume.
    around_a_hole = [_item(0, 0, 8, 8, "a"), _item(16, 0, 8, 8, "c"), _item(0, 8, 24, 4, "d")]

    assert _first_free_slot(around_a_hole, 8, 8) == (8, 0)


def test_a_widget_too_wide_for_the_gap_skips_it() -> None:
    # An 8-wide hole cannot take a 16-wide widget; picking it anyway would overlap silently, since
    # nothing downstream re-checks the server's own placement.
    around_a_hole = [_item(0, 0, 8, 8, "a"), _item(16, 0, 8, 8, "c")]

    assert _first_free_slot(around_a_hole, 16, 8) == (0, 8)


def test_the_last_row_is_usable() -> None:
    # `y + h > GRID_ROWS` and `y + h >= GRID_ROWS` differ by exactly one row, and the row they
    # differ on is the only one this rule ever excludes wrongly.
    filled_above = [_item(0, 0, GRID_COLUMNS, GRID_ROWS - 1)]

    assert _first_free_slot(filled_above, GRID_COLUMNS, 1) == (0, GRID_ROWS - 1)


@pytest.mark.parametrize("w", range(1, GRID_COLUMNS + 1))
def test_placement_never_runs_past_an_edge(w: int) -> None:
    # Past either edge the write path 422s, and this is a write path — a slot it invents here would
    # poison the row for every later PUT /layout the client attempts.
    packed = [_item(0, 0, GRID_COLUMNS, 4)]

    slot = _first_free_slot(packed, w, 4)

    assert slot is not None
    x, y = slot
    assert x + w <= GRID_COLUMNS
    assert y + 4 <= GRID_ROWS


def test_a_full_board_reports_no_room_rather_than_inventing_one() -> None:
    # The grid is bounded, so it can genuinely run out. Returning a slot below the last row would
    # place the widget where no gesture could ever reach it — worse than refusing the add.
    packed = [_item(x, y, 8, 8, f"w{x}-{y}") for y in range(0, GRID_ROWS, 8) for x in range(0, GRID_COLUMNS, 8)]

    assert _first_free_slot(packed, 8, 8) is None


def test_a_widget_taller_than_the_grid_never_fits() -> None:
    assert _first_free_slot([], 1, GRID_ROWS + 1) is None


def test_items_missing_coordinates_are_treated_as_occupying_space() -> None:
    # Reads are deliberately unvalidated, so a historical row can be missing a key. Defaulting it
    # out of the way would place a new widget on top of one that is really there.
    assert _first_free_slot([{"i": "legacy"}], 1, 1) == (1, 0)


# ── Fitting a widget the gap is too small for ────────────────────────────────────────────────────


def test_a_gap_that_fits_the_default_leaves_it_alone() -> None:
    # The common path, and the one that must not pay for the rest: an untouched default size back.
    assert _fit_widget([], 8, 9) == (0, 0, 8, 9)


@pytest.mark.parametrize(("gap_w", "gap_h"), [(7, 8), (8, 8), (7, 9), (2, 3)])
def test_a_gap_smaller_than_the_default_shrinks_the_widget_instead_of_refusing(gap_w: int, gap_h: int) -> None:
    """A gap one short on either axis is ordinary, and 'the dashboard is full' is untrue there."""
    # A single free rectangle of exactly gap_w x gap_h, walled in on both sides.
    layout = [
        _item(0, 0, GRID_COLUMNS - gap_w, GRID_ROWS, "left"),
        _item(GRID_COLUMNS - gap_w, gap_h, gap_w, GRID_ROWS - gap_h, "below"),
    ]

    placement = _fit_widget(layout, 8, 9)

    assert placement is not None
    x, y, w, h = placement
    # It takes the whole gap rather than some smaller box that also fits — giving up only the area
    # it has to is the difference between this and shrinking until something happens to work.
    assert (x, y, w, h) == (GRID_COLUMNS - gap_w, 0, gap_w, gap_h)


def test_only_a_board_without_one_free_cell_is_refused() -> None:
    # The 409 still exists, and now means what it says. One free cell is enough for a 1x1: the grid
    # is bounded, so even that widget is on screen and can be dragged bigger.
    packed = [_item(0, 0, GRID_COLUMNS, GRID_ROWS, "everything")]
    assert _fit_widget(packed, 8, 9) is None

    one_cell_short = [
        _item(0, 0, GRID_COLUMNS - 1, GRID_ROWS, "most"),
        _item(GRID_COLUMNS - 1, 1, 1, GRID_ROWS - 1, "rest"),
    ]
    assert _fit_widget(one_cell_short, 8, 9) == (GRID_COLUMNS - 1, 0, 1, 1)
