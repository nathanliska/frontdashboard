"""Shared machinery for the guards that enforce a convention rather than a behavior.

A guard reads a source of truth, compares it to whatever has to mirror it, and fails the build on
a gap. The ones that enumerate router sources share that walk here, so a defect in it can only
exist in one place — and `test_conventions.py` is what stops that one place going quiet, since a
walk returning nothing skips rather than fails.

`router_modules` walks with `rglob`: a router that grows into a package stays covered, which a
flat walk cannot manage and cannot report. See the guard index in AGENTS.md for which rule each
guard enforces.
"""

import ast
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
ROUTERS = BACKEND_ROOT / "app" / "routers"


def router_modules() -> list[Path]:
    """Every router source file, including any that has grown into a package.

    Excludes `__init__.py`, which assembles a router rather than defining routes — but note a
    package's `__init__.py` may hold real handlers, so a guard that cares should say so.
    """
    return sorted(p for p in ROUTERS.rglob("*.py") if p.name != "__init__.py")


def parsed_router_modules() -> list[tuple[Path, ast.AST]]:
    """Router sources already parsed, for guards that walk the tree rather than match text."""
    return [(path, ast.parse(path.read_text())) for path in router_modules()]


def calls(tree: ast.AST) -> list[ast.Call]:
    return [node for node in ast.walk(tree) if isinstance(node, ast.Call)]


def attribute_calls(tree: ast.AST, obj: str, attr: str) -> list[ast.Call]:
    """Find `obj.attr(...)` calls, ignoring how `obj` was named at the call site.

    Matches a bare `manager.broadcast(...)` and an attribute path ending in it, because
    `sse/manager.py` hands each client a `manager` back-reference to the same singleton — so
    `client.manager.broadcast(...)` reaches the fan-out just as directly.
    """
    found = []
    for call in calls(tree):
        func = call.func
        if not isinstance(func, ast.Attribute) or func.attr != attr:
            continue
        value = func.value
        named = isinstance(value, ast.Name) and value.id == obj
        attributed = isinstance(value, ast.Attribute) and value.attr == obj
        if named or attributed:
            found.append(call)
    return found


def dict_values_for_key(tree: ast.AST, key: str) -> list[tuple[int, str]]:
    """Every literal string written into `key`'s list value, with its line number.

    Only literals are reachable this way — a computed value needs its own assertion against
    whatever computes it.
    """
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for dict_key, value in zip(node.keys, node.values, strict=True):
            if not (isinstance(dict_key, ast.Constant) and dict_key.value == key):
                continue
            if not isinstance(value, (ast.List, ast.Tuple)):
                continue
            for element in value.elts:
                if isinstance(element, ast.Constant) and isinstance(element.value, str):
                    found.append((element.lineno, element.value))
    return found
