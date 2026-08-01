"""Fails the build when a router hand-rolls the commit/broadcast dance.

The ordering this protects is silent when broken: the write succeeds, the actor sees their own
change, and only other people's tabs go stale. `test_rate_limit_coverage.py` is the same shape and
the same reason — a convention nothing checks is one that eventually gets missed.
"""

import ast
from pathlib import Path

import pytest

ROUTERS = Path(__file__).resolve().parent.parent / "app" / "routers"

# Its own commit is the one the seam performs; it is the definition, not a violation.
_SEAM = "commit_and_broadcast"


def _router_modules() -> list[Path]:
    return sorted(p for p in ROUTERS.glob("*.py") if p.name != "__init__.py")


def _calls(tree: ast.AST) -> list[ast.Call]:
    return [node for node in ast.walk(tree) if isinstance(node, ast.Call)]


def _attribute_calls(tree: ast.AST, obj: str, attr: str) -> list[ast.Call]:
    """Find `obj.attr(...)` calls, ignoring how `obj` was named at the call site."""
    found = []
    for call in _calls(tree):
        func = call.func
        if not isinstance(func, ast.Attribute) or func.attr != attr:
            continue
        value = func.value
        if isinstance(value, ast.Name) and value.id == obj:
            found.append(call)
    return found


@pytest.mark.parametrize("module", _router_modules(), ids=lambda p: p.name)
def test_routers_do_not_broadcast_directly(module: Path) -> None:
    """Fan-out goes through the seam, so it cannot be sent before the commit.

    Deliberately the only rule here. A bare `db.commit()` is fine — a write that broadcasts
    nothing cannot leave anyone stale, and invites and auth both commit without an audience.
    """
    tree = ast.parse(module.read_text())

    direct = _attribute_calls(tree, "manager", "broadcast")

    assert not direct, (
        f"{module.name} calls manager.broadcast directly at line(s) {[node.lineno for node in direct]}. Use {_SEAM}(), which commits first."
    )
