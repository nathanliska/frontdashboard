"""`--breakpoint-nav` is a sum, and every term of it lives in a different file.

It is the width below which the rail costs more than the board it leaves: the grid's stack
threshold, plus the rail at its widest, plus the page padding in force there. None of those three
knows it is a term, so moving one leaves the breakpoint describing a layout that no longer exists —
and nothing renders wrong until someone resizes a window to exactly the wrong width.

Python rather than vitest because the value is in CSS: Vite's `?raw` returns an empty string for a
stylesheet, and reaching for `node:fs` would mean putting Node's types on the app tsconfig, which
deliberately withholds them from app source.
"""

import re
from pathlib import Path

from tests.conventions import FRONTEND_ROOT

_REM = 16
# Tailwind's spacing scale: one unit is 0.25rem.
_UNIT = 4

_CSS = FRONTEND_ROOT / "src" / "index.css"
_GRID = FRONTEND_ROOT / "src" / "components" / "dashboard" / "DashboardGrid.tsx"
_SIDEBAR = FRONTEND_ROOT / "src" / "components" / "layout" / "Sidebar.tsx"
_SHELL = FRONTEND_ROOT / "src" / "components" / "layout" / "AppShell.tsx"


def _search(pattern: str, path: Path) -> str:
    match = re.search(pattern, path.read_text())
    assert match, f"`{pattern}` no longer matches anything in {path.name}, so this guard reads nothing"
    return match.group(1)


def test_the_nav_breakpoint_is_the_sum_of_what_it_is_derived_from() -> None:
    breakpoint_px = float(_search(r"--breakpoint-nav:\s*([\d.]+)rem", _CSS)) * _REM
    stack_below = int(_search(r"STACK_BELOW = (\d+)", _GRID))
    # The rail at its widest — the collapsed width is a preference, not what the breakpoint pays for.
    rail = max((int(width) for width in re.findall(r"nav:w-(\d+)", _SIDEBAR.read_text())), default=0) * _UNIT
    # `lg:` because the nav breakpoint sits above it, so this is the padding in force there —
    # read off `<main` itself, so another element's padding cannot answer for it.
    padding = int(_search(r"<main[^>]*\blg:p-(\d+)", _SHELL)) * _UNIT * 2

    assert rail > 0, "no `nav:w-*` in Sidebar.tsx — the rail width this guard needs is gone"
    assert breakpoint_px == stack_below + rail + padding, (
        f"--breakpoint-nav is {breakpoint_px:.0f}px but its terms now sum to "
        f"{stack_below + rail + padding}px ({stack_below} board + {rail} rail + {padding} padding). "
        "Re-derive the breakpoint, or say in index.css why it is no longer the sum"
    )
