#!/usr/bin/env bash
# Branch protection would do this server-side, but it needs a public repo or GitHub Pro — so the
# rule lives here instead. Bypass with `git push --no-verify` when a fix genuinely cannot wait.
set -euo pipefail

refuse() {
    echo "Refusing to push to main: work goes on a branch and lands through a PR (AGENTS.md)." >&2
    echo "  git switch -c <describes-the-change>" >&2
    exit 1
}

is_main() {
    [[ "${1##refs/heads/}" == "main" ]]
}

# The ref being written on the remote is what matters, not the branch in hand — checking only the
# latter lets `git push origin HEAD:main` walk past the guard from any feature branch.
if [[ -n "${PRE_COMMIT_REMOTE_BRANCH:-}" ]] && is_main "${PRE_COMMIT_REMOTE_BRANCH}"; then
    refuse
fi

# Read regardless of what the variable said: it names one branch, and a multi-ref push writes
# several. Plain git hooks get "<local ref> <local sha> <remote ref> <remote sha>" per ref here.
if [[ ! -t 0 ]]; then
    while read -r _ _ remote_ref _; do
        if is_main "${remote_ref}"; then refuse; fi
    done
fi

# Defence in depth for the case where neither source named a target.
if [[ "$(git symbolic-ref --short HEAD 2>/dev/null || echo '')" == "main" ]]; then refuse; fi
