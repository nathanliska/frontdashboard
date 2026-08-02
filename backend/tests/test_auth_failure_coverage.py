"""Every rejection in the auth layer goes through `auth_failure`.

The counter is only worth reading if it is complete, and completeness is the weak point of a
metric someone has to remember to increment. Raising through the seam makes forgetting a build
failure instead of a silently under-counted series.
"""

import ast
import pathlib

_AUTH_LAYER = (
    pathlib.Path(__file__).resolve().parents[1] / "app" / "auth" / "dependencies.py",
    pathlib.Path(__file__).resolve().parents[1] / "app" / "routers" / "auth.py",
)

# 422 is request-shape validation, not a rejected credential — it never reaches the counter.
_AUTH_STATUS_NAMES = {"HTTP_401_UNAUTHORIZED", "HTTP_403_FORBIDDEN"}

# Authorization, not authentication: the caller is who they claim to be and is refused a resource.
# Counting it as an auth failure would blur the one question the metric exists to answer. Listed by
# function so the exemption is a deliberate edit rather than a silent gap.
_EXEMPT_FUNCTIONS = {"_normalize_accessible_dashboard_ids"}


def _enclosing_function(tree: ast.AST, lineno: int) -> str:
    """Innermost function containing the given line, or '' at module scope."""
    best = ""
    best_line = -1
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        end = node.end_lineno or node.lineno
        if node.lineno <= lineno <= end and node.lineno > best_line:
            best, best_line = node.name, node.lineno
    return best


def _raised_call_names(tree: ast.AST) -> list[tuple[str, int]]:
    """Every `raise <Name>(...)` in the tree, as (callee name, line)."""
    raised: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
            continue
        func = node.exc.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        raised.append((name, node.lineno))
    return raised


def _mentions_auth_status(call: ast.Call) -> bool:
    return any(isinstance(n, ast.Attribute) and n.attr in _AUTH_STATUS_NAMES for n in ast.walk(call))


def test_the_scan_actually_finds_raises() -> None:
    """Guards the guard: a parse that finds nothing would pass every assertion below vacuously."""
    total = sum(len(_raised_call_names(ast.parse(path.read_text()))) for path in _AUTH_LAYER)
    assert total > 5, f"AST scan found only {total} raises across the auth layer — it is not parsing what it thinks"


def test_no_auth_rejection_bypasses_the_counter() -> None:
    offenders: list[str] = []
    for path in _AUTH_LAYER:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
                continue
            func = node.exc.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name == "auth_failure" or not _mentions_auth_status(node.exc):
                continue
            if _enclosing_function(tree, node.lineno) in _EXEMPT_FUNCTIONS:
                continue
            offenders.append(f"{path.name}:{node.lineno}")

    assert not offenders, "auth rejections raised without counting — use auth_failure(...):\n  " + "\n  ".join(offenders)
