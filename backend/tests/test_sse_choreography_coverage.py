"""Fails the build when a router hand-rolls the commit/broadcast dance.

The ordering this protects is silent when broken: the write succeeds, the actor sees their own
change, and only other people's tabs go stale. `test_rate_limit_coverage.py` is the same shape and
the same reason — a convention nothing checks is one that eventually gets missed.
"""

import ast
from pathlib import Path

import pytest

from tests.conventions import attribute_calls, parsed_router_modules

_ROUTER_IDS = [path.name for path, _ in parsed_router_modules()]

# Its own commit is the one the seam performs; it is the definition, not a violation.
_SEAM = "commit_and_broadcast"


@pytest.mark.parametrize(("module", "tree"), parsed_router_modules(), ids=_ROUTER_IDS)
def test_routers_do_not_broadcast_directly(module: Path, tree: ast.AST) -> None:
    """Fan-out goes through the seam, so it cannot be sent before the commit.

    Deliberately the only rule here. A bare `db.commit()` is fine — a write that broadcasts
    nothing cannot leave anyone stale, and invites and auth both commit without an audience.
    """
    direct = attribute_calls(tree, "manager", "broadcast")

    assert not direct, (
        f"{module.name} calls manager.broadcast directly at line(s) {[node.lineno for node in direct]}. Use {_SEAM}(), which commits first."
    )
