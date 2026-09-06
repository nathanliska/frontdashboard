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

from tests.conventions import DASHBOARD_GRID, FRONTEND_ROOT, INDEX_CSS, declared_int

_REM = 16
# Tailwind's spacing scale: one unit is 0.25rem.
_UNIT = 4

_SIDEBAR = FRONTEND_ROOT / "src" / "components" / "layout" / "Sidebar.tsx"
_SHELL = FRONTEND_ROOT / "src" / "components" / "layout" / "AppShell.tsx"


def _search(pattern: str, text: str, where: str) -> str:
    match = re.search(pattern, text)
    assert match, f"`{pattern}` no longer matches anything in {where}, so this guard reads nothing"
    return match.group(1)


def test_the_nav_breakpoint_is_the_sum_of_what_it_is_derived_from() -> None:
    breakpoint_px = float(_search(r"--breakpoint-nav:\s*([\d.]+)rem", INDEX_CSS.read_text(), INDEX_CSS.name)) * _REM
    stack_below = declared_int(DASHBOARD_GRID, "STACK_BELOW")

    # The rail at its widest — the collapsed width is a preference, not what the breakpoint pays for.
    widths = re.findall(r"nav:w-(\d+)", _SIDEBAR.read_text())
    assert widths, "no `nav:w-*` in Sidebar.tsx — the rail width this guard needs is gone"
    rail = max(map(int, widths)) * _UNIT

    # `lg:` because the nav breakpoint sits above it, so this is the padding in force there. Read off
    # `<main` itself, and only the shorthand: a horizontal override beside it would change the sum.
    main_tag = _search(r"(<main[^>]*>)", _SHELL.read_text(), _SHELL.name)
    assert not re.search(r"\blg:p[xlr]-", main_tag), (
        "an `lg:` horizontal padding override on <main> changes the padding in force at the nav "
        "breakpoint — teach this guard to read it before trusting the sum"
    )
    padding = int(_search(r"\blg:p-(\d+)", main_tag, "<main>")) * _UNIT * 2

    assert breakpoint_px == stack_below + rail + padding, (
        f"--breakpoint-nav is {breakpoint_px:.0f}px but its terms now sum to "
        f"{stack_below + rail + padding}px ({stack_below} board + {rail} rail + {padding} padding). "
        "Re-derive the breakpoint, or say in index.css why it is no longer the sum"
    )
