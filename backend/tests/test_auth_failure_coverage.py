"""Every rejection in the auth layer goes through `auth_failure`.

The counter is only worth reading if it is complete, and completeness is the weak point of a
metric someone has to remember to increment. Raising through the seam makes forgetting a build
failure instead of a silently under-counted series.
"""

import ast
import pathlib

from app.metrics import AUTH_FAILURE_PAIRS

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


def _raised_auth_failure_pairs() -> set[tuple[str, str]]:
    """Every (operation, reason) the auth layer can raise, read out of the source.

    A reason is often a conditional — `"unknown_user" if user is None else "bad_password"` — so
    both branches are collected rather than the expression being evaluated.
    """
    pairs: set[tuple[str, str]] = set()
    for path in _AUTH_LAYER:
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call) or getattr(node.func, "id", None) != "auth_failure":
                continue
            if len(node.args) < 2:
                continue
            operation, reason = node.args[0], node.args[1]
            if not isinstance(operation, ast.Constant) or not isinstance(operation.value, str):
                continue
            reasons = [reason.body, reason.orelse] if isinstance(reason, ast.IfExp) else [reason]
            for candidate in reasons:
                if isinstance(candidate, ast.Constant) and isinstance(candidate.value, str):
                    pairs.add((operation.value, candidate.value))
    return pairs


def test_the_pair_scan_sees_both_branches_of_a_conditional_reason() -> None:
    """Guards the guard: login's reason is an `if` expression, and missing it would look like a pass."""
    pairs = _raised_auth_failure_pairs()
    assert ("login", "unknown_user") in pairs
    assert ("login", "bad_password") in pairs


def test_every_raisable_pair_has_a_series_before_it_first_happens() -> None:
    """A pair absent from the declared set is invisible to `increase()` the first time it fires."""
    undeclared = _raised_auth_failure_pairs() - set(AUTH_FAILURE_PAIRS)

    assert not undeclared, f"add to metrics.AUTH_FAILURE_PAIRS, or the first one is uncountable: {sorted(undeclared)}"


def test_no_declared_pair_is_unreachable() -> None:
    """The other direction: a pair nothing raises is a permanent zero that reads like coverage."""
    unreachable = set(AUTH_FAILURE_PAIRS) - _raised_auth_failure_pairs()

    assert not unreachable, f"declared but never raised: {sorted(unreachable)}"


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
