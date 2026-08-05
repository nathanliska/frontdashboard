#!/usr/bin/env bash
# Branch protection would do this server-side, but it needs a public repo or GitHub Pro — so the
# rule lives here instead. Bypass with `git push --no-verify` when a fix genuinely cannot wait.
set -euo pipefail

branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo '')"

if [[ "${branch}" == "main" ]]; then
    echo "Refusing to push: work goes on a branch and lands through a PR (AGENTS.md)." >&2
    echo "  git switch -c <describes-the-change>" >&2
    exit 1
fi
