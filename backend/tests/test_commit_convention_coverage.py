"""The Conventional Commit types are listed once, and every gate that checks them reads that list.

Two gates enforce the same grammar on different strings: the commit-msg hook on each subject, and
CI on the PR title a squash merge keeps. Their type lists are separate literals in separate files,
so one can gain a type the other rejects — and the failure surfaces only as a PR that cannot be
titled what its own commits were named.

`.pre-commit-config.yaml` is the list; this fails the build when the workflow drifts from it.
"""

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PRE_COMMIT = _REPO / ".pre-commit-config.yaml"
_CI = _REPO / ".github" / "workflows" / "ci.yml"

# The args block runs to the next key at hook-entry indentation or shallower.
_HOOK_ARGS = re.compile(r"id:\s*conventional-pre-commit\b.*?\bargs:\n(.*?)(?=\n\s{0,8}[-\w]+:)", re.S)
_ARG_ITEM = re.compile(r"^\s*-\s*(\w+)\s*$", re.M)
_CI_TYPES = re.compile(r"^\s*types='([^']+)'", re.M)


def _hook_types() -> set[str]:
    block = _HOOK_ARGS.search(_PRE_COMMIT.read_text())
    assert block, "conventional-pre-commit has no args block — the type list moved"
    return set(_ARG_ITEM.findall(block.group(1)))


def _ci_types() -> set[str]:
    match = _CI_TYPES.search(_CI.read_text())
    assert match, "the PR title check has no types='...' line — the CI gate moved or went away"
    return set(match.group(1).split("|"))


def test_both_lists_are_found() -> None:
    """A vacuous pass is the failure mode this module exists to avoid."""
    assert len(_hook_types()) > 1, "parsed a suspiciously short hook type list"
    assert len(_ci_types()) > 1, "parsed a suspiciously short CI type list"


def test_ci_accepts_exactly_the_types_the_hook_does() -> None:
    hook, ci = _hook_types(), _ci_types()
    assert hook == ci, f"only the hook accepts {hook - ci or '{}'}; only CI accepts {ci - hook or '{}'}"
