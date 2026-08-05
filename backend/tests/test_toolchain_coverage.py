"""The Node version is pinned once, and everything that needs it reads that pin.

No Dependabot ecosystem owns a `node-version:` string in a workflow — `github-actions` updates the
`uses:` reference and `docker` updates a `FROM` line, so a bump to the images leaves CI behind and
nothing says so. That is what happened when the images moved to 26 while four workflow jobs stayed
on 24, and it is a split toolchain: unit tests on one major, the shipped bundle built on another.

So `.nvmrc` is the pin, CI reads it with `node-version-file`, and this fails the build if either
Dockerfile drifts from it or a literal pin creeps back into a workflow.
"""

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_NVMRC = _REPO / ".nvmrc"
_DOCKERFILES = [_REPO / "frontend" / "Dockerfile", _REPO / "frontend" / "Dockerfile.prod"]
_WORKFLOWS = sorted((_REPO / ".github" / "workflows").glob("*.yml"))

_FROM_NODE = re.compile(r"^FROM node:(\d+)", re.M)
# `node-version-file:` shares the prefix, so the boundary is what keeps this from matching it.
_LITERAL_PIN = re.compile(r"^\s*node-version:\s*\S", re.M)


def _pinned_major() -> str:
    return _NVMRC.read_text().strip()


def test_the_pin_exists() -> None:
    """A vacuous pass is the failure mode this module exists to avoid."""
    assert _NVMRC.is_file(), ".nvmrc is missing — nothing pins the Node version"
    assert _pinned_major().isdigit(), f".nvmrc should hold a bare major, got {_pinned_major()!r}"
    assert _WORKFLOWS, "no workflows found — this test would pass having checked nothing"


def test_both_images_build_on_the_pinned_major() -> None:
    expected = _pinned_major()
    for path in _DOCKERFILES:
        majors = _FROM_NODE.findall(path.read_text())
        assert majors, f"{path.relative_to(_REPO)} has no `FROM node:` line to check"
        assert set(majors) == {expected}, f"{path.relative_to(_REPO)} builds on Node {set(majors)}, but .nvmrc pins {expected}"


def test_no_workflow_pins_a_node_version_literally() -> None:
    """A literal pin is a second source of truth, which is the drift this replaced."""
    offenders = [str(p.relative_to(_REPO)) for p in _WORKFLOWS if _LITERAL_PIN.search(p.read_text())]
    assert not offenders, f"use `node-version-file: .nvmrc` instead of a literal pin: {offenders}"
