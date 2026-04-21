#!/usr/bin/env bash
# prepare-commit-msg hook: normalizes commit messages before the
# conventional-commit validator runs.
#
# Normalizations applied:
#   1. Trim leading/trailing whitespace from subject line
#   2. Normalize type aliases (feature->feat, bugfix->fix)
#   3. Lowercase the first character of the description after 'type[(scope)]: '
#   4. Remove trailing period(s) from the subject line

set -euo pipefail

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="${2:-}"

# Skip merge commits, squash commits, and template messages
case "$COMMIT_SOURCE" in
    merge|squash)
        exit 0
        ;;
esac

# Read the first line (subject)
subject=$(head -n1 "$COMMIT_MSG_FILE")

# Skip if empty or starts with '#' (comment-only)
if [[ -z "$subject" ]] || [[ "$subject" =~ ^# ]]; then
    exit 0
fi

# 1. Trim leading/trailing whitespace
subject=$(echo "$subject" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

# 2. Normalize type aliases
subject=$(echo "$subject" | sed -E 's/^feature(\(|:)/feat\1/; s/^bugfix(\(|:)/fix\1/')

# 3. Lowercase the first character of the description after 'type[(scope)]: '
#    Matches: type: Desc  or  type(scope): Desc  or  type(scope)!: Desc
subject=$(echo "$subject" | sed -E 's/^([a-z]+(\([^)]*\))?!?:[[:space:]]+)([A-Z])/\1\l\3/')

# 4. Remove trailing period(s)
subject=$(echo "$subject" | sed 's/\.\+$//')

# Reconstruct the file: normalized subject + rest of message
rest=$(tail -n +2 "$COMMIT_MSG_FILE")
{
    echo "$subject"
    if [[ -n "$rest" ]]; then
        echo "$rest"
    fi
} > "$COMMIT_MSG_FILE"
