"""What `conventions.py` does that a reader would not otherwise assume.

The vacuous-guard problem is `empty_parameter_set_mark` in `pyproject.toml`: a walk returning
nothing fails collection rather than skipping, for every parametrized test rather than these two.
What is left here is the behaviour specific to this module — that the walk descends, and which
call shapes count as a broadcast.
"""

import ast
from pathlib import Path

import pytest

from tests import conventions


def test_the_walk_descends_into_a_router_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`rglob`, not `glob` — a router that grows into a package must stay covered.

    A flat walk reports the same *count* the day a router becomes a directory, so the gap it opens
    cannot be seen from the number of files alone.
    """
    (tmp_path / "flat.py").write_text("")
    (tmp_path / "grown").mkdir()
    (tmp_path / "grown" / "__init__.py").write_text("")
    (tmp_path / "grown" / "handlers.py").write_text("")
    monkeypatch.setattr(conventions, "ROUTERS", tmp_path)

    found = {path.name for path in conventions.router_modules()}

    assert found == {"flat.py", "handlers.py"}


def test_a_broadcast_counts_however_the_manager_was_reached() -> None:
    """`sse/manager.py` hands each client a back-reference to the singleton.

    So `client.manager.broadcast(...)` reaches the fan-out as directly as the bare form, and a
    guard seeing only one shape would miss that bypass.
    """
    tree = ast.parse(
        "async def h(manager, client):\n    await manager.broadcast(1)\n    await client.manager.broadcast(2)\n    await manager.publish(3)\n"
    )

    found = conventions.attribute_calls(tree, "manager", "broadcast")

    assert [call.lineno for call in found] == [2, 3]
