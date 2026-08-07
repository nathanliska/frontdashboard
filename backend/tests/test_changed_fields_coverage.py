"""Every `changed_fields` value a router emits is a member of the closed vocabulary.

The frontend branches on these strings to decide what to refetch, and an unrecognised value fails
*open*: the store falls through to a full reload, which looks like a slow page rather than a bug.
So the wrong value is never reported by the app — it is reported by nothing at all.

`ChangedField` reaching the frontend as a generated enum stops a consumer testing for a value no
producer emits. This is the other direction: a producer inventing a value no consumer knows.

Ordering is deliberately *not* asserted. Rows already in the activity log carry `["widgets",
"layout"]` unsorted and are immutable, so sortedness could never be an invariant — order
independence is the real one, and it is pinned on the consumer side in `dashboard.test.ts`.
"""

import ast
from pathlib import Path

import pytest

from app.models.activity import ChangedField
from app.schemas.dashboards import DashboardUpdate

_ROUTERS = Path(__file__).resolve().parents[1] / "app" / "routers"
_VOCABULARY = {member.value for member in ChangedField}


def _router_modules() -> list[Path]:
    return sorted(p for p in _ROUTERS.glob("*.py") if p.name != "__init__.py")


def _changed_fields_values(tree: ast.AST) -> list[tuple[int, str]]:
    """Every literal string assigned into a `changed_fields` key, with its line number.

    Only literals are reachable this way; a computed value (the PATCH body's field names) is
    covered by `test_patchable_dashboard_fields_are_vocabulary` instead.
    """
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values, strict=True):
            if not (isinstance(key, ast.Constant) and key.value == "changed_fields"):
                continue
            if not isinstance(value, (ast.List, ast.Tuple)):
                continue
            for element in value.elts:
                if isinstance(element, ast.Constant) and isinstance(element.value, str):
                    found.append((element.lineno, element.value))
    return found


@pytest.mark.parametrize("module", _router_modules(), ids=lambda p: p.name)
def test_routers_emit_only_vocabulary_members(module: Path) -> None:
    tree = ast.parse(module.read_text())
    offenders = [f"{module.name}:{lineno} emits {value!r}" for lineno, value in _changed_fields_values(tree) if value not in _VOCABULARY]
    assert not offenders, (
        "changed_fields values outside the ChangedField vocabulary:\n  "
        + "\n  ".join(offenders)
        + f"\nAdd the member to ChangedField (and teach the consumers) or use one of: {sorted(_VOCABULARY)}"
    )


@pytest.mark.parametrize("module", _router_modules(), ids=lambda p: p.name)
def test_routers_reference_the_enum_rather_than_bare_strings(module: Path) -> None:
    """A bare string still passes the vocabulary check today and drifts silently tomorrow."""
    tree = ast.parse(module.read_text())
    offenders = [f"{module.name}:{lineno} hardcodes {value!r}" for lineno, value in _changed_fields_values(tree)]
    assert not offenders, "changed_fields should be built from ChangedField members, not string literals:\n  " + "\n  ".join(offenders)


def test_patchable_dashboard_fields_are_vocabulary() -> None:
    """`PATCH /dashboards/{id}` emits its own field names, so the schema *is* a producer.

    Adding a field to `DashboardUpdate` silently starts emitting that name on the wire. Here it
    is a build failure instead — and it fails before the runtime `ChangedField(field)` lookup can
    turn the same mistake into a 500 on a valid request.
    """
    unknown = set(DashboardUpdate.model_fields) - _VOCABULARY
    assert not unknown, (
        f"DashboardUpdate fields absent from ChangedField: {sorted(unknown)} — add each as a member and give the frontend predicates a case for it"
    )
