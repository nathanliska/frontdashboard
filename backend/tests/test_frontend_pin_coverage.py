"""The one frontend pin that has to follow another package rather than lead it.

`react-resizable` is a direct dependency only so the stylesheet import is declared. The components
it also ships are react-grid-layout's to render, from its own copy — so leading that library's range
resolves two copies, and our stylesheet then styles markup a different version produced.

Dependabot is told to ignore its majors for that reason, and an ignore is silent by nature. This is
what fails when react-grid-layout moves and the ignore has become stale.
"""

import json
from pathlib import Path

_LOCK = Path(__file__).resolve().parents[2] / "frontend" / "package-lock.json"


def test_react_resizable_tracks_react_grid_layout() -> None:
    packages = json.loads(_LOCK.read_text())["packages"]
    ours = packages[""]["dependencies"]["react-resizable"]
    theirs = packages["node_modules/react-grid-layout"]["dependencies"]["react-resizable"]

    assert ours == theirs, (
        f"react-resizable is pinned {ours} but react-grid-layout depends on {theirs} — "
        "match it, and drop the dependabot ignore if that library has moved major"
    )
