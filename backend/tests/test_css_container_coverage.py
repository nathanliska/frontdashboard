"""A hand-written `@container` rule and the element it queries live in different files.

Tailwind's `@container` utility is inline-size, so a query on height has to be written as plain CSS
— which puts the rule in `index.css` and the class that declares the container in a component. No
type links them, and a rule matching nothing throws nothing: the element simply keeps its default
state, which only a person resizing a widget would ever notice.

`containerQueryCoverage.test.ts` guards the other direction, where a Tailwind variant is used in a
component that never declares `@container`.
"""

import re

import pytest

from tests.conventions import FRONTEND_ROOT

_CSS = FRONTEND_ROOT / "src" / "index.css"
_SOURCES = sorted(FRONTEND_ROOT.glob("src/**/*.tsx"))


def _queried_classes() -> list[str]:
    blocks = re.findall(r"@container[^{]*\{(.*?)\n\}", _CSS.read_text(), re.DOTALL)
    return sorted({name for block in blocks for name in re.findall(r"\.([a-z][\w-]*)", block)})


@pytest.mark.parametrize("class_name", _queried_classes())
def test_a_queried_class_declares_its_container_and_is_rendered(class_name: str) -> None:
    css = _CSS.read_text()

    assert re.search(rf"\.{re.escape(class_name)}\s*\{{[^}}]*container-type", css), (
        f"`.{class_name}` is queried by an @container rule in {_CSS.name} but never declares "
        "`container-type`, so the query resolves against some ancestor or nothing at all"
    )
    assert any(class_name in source.read_text() for source in _SOURCES), (
        f"no component renders `{class_name}`, so the @container rule naming it in {_CSS.name} "
        "matches nothing — the element keeps its default state and nothing fails"
    )
