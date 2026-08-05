---
name: "pr-checklist"
description: "Pre-merge checklist for this repo — test gaps, the conventions that fail the build, the doc sweep, and the PR body shape. Run before opening a pull request and again before asking for a merge."
---

# PR Checklist

Check the current branch against everything below. **Output only actionable items** — if an area
needs nothing, omit it rather than reporting that it's fine. The user should get a list of todos,
not a report card.

Give these items precedence over general instructions given earlier in the session.

## The branch

- Read the whole branch diff first (`git diff main...HEAD`), not just the last commit.
- The branch name should describe the change. Don't rename an existing branch unless asked.
- Commits are Conventional Commit format, and so is the **PR title** — the commit-msg hook enforces
  the former and nothing enforces the latter.

## Tests

- Are there gaps around new or changed behavior? Fill them.
- **Prove each new test by breaking the thing back**: stash the change, watch it fail, restore. A
  caching, ordering or fan-out test that has never been seen to fail is not evidence.
- If the change alters _how_ a result is produced rather than _what_ it is, assert on the mechanism
  — a call count, `getState` — not the result, which passes against the unfixed code.
- Run what would actually catch a regression here: `make test`, or the narrower suite plus a reason.

## The conventions that fail the build

Each of these has a test that fails CI when missed. Check the ones the diff touches:

- Every non-GET route: `_csrf: None = Depends(require_csrf)` **and** `@limiter.limit(WRITE_LIMIT)`
  with a `request: Request` parameter.
- Auth rejections raise `auth_failure(...)`, never a bare `HTTPException`.
- SSE writes go through `commit_and_broadcast(...)`, with the event dict built _before_ the call.
- A new table with a `dashboard_id`/`users` FK is in the matching sweep in `services/retention.py`.
- A new model module is imported in `alembic/env.py` and has a hand-authored migration.
- A new activity event type has a `formatActivityEvent` case **and** an `ACTIVITY_CATEGORIES` entry.
- A new entity type has its event names in `hooks/useSSE.ts` **and** a `handleXResourceEvent` router.
- A new resource cache calls `registerResourceReset(...)` at module scope.
- Backend schema changed → `make contracts`, and the regenerated contract is committed.
- Any metric renamed → the dashboards and `observability/alerts.yml` still name something real.

## Documentation

Sweep these against the diff and update what the change made untrue:

- **CONTEXT.md** — a feature landing or being deferred. It is a snapshot, not a changelog.
- **ADR** (+ `docs/adr/INDEX.md`) for a cross-cutting decision; **FDR** for one local to a feature,
  bumping **Last reviewed**.
- **docs/GLOSSARY.md** for a coined or renamed term.
- **docs/TODO.md** — remove or update the finding this ships, in the same change.
- **CLAUDE.md** for a new standing rule or gotcha.
- After removing a concept, grep its vocabulary repo-wide. Recall misses FDRs and ADR titles.

## User-facing UI

If the branch changes what a user sees, the PR body needs **screenshots of the rendered states**,
drag-dropped into the description so GitHub stores them as attachments — never committed to the
repo. Use the `live-verify` skill to run the real production images and capture them.

`live-verify` is also the only check that catches a blank page, a stray refetch after a write, or a
serving fault, so run it for anything touching the frontend, `Caddyfile.prod` or either
`Dockerfile.prod`.

## PR body

Write it for a reviewer, not as a changelog. Read the complete branch diff before writing it.

- **Why** — the problem and the intended outcome.
- **What changed** — observable behavior, and the implementation decisions worth knowing.
- **Test plan** — the exact checks run and their results, plus anything still unverified.

Call out migration, rollout, security or operational implications when they apply. Link the ADRs,
FDRs and TODO findings involved. Use `Closes #123.` when it closes an issue.

For multiline bodies with `gh`, write Markdown to a file and use `--body-file` — never escaped `\n`
in `--body`. Afterwards, read it back with
`gh pr view --json body,baseRefName,closingIssuesReferences` and confirm it matches the diff.

The read-back is the check that the write landed, not a formality: `gh pr edit` can fail on
something unrelated to your edit and leave the previous title and body in place. When it does,
`gh api repos/{owner}/{repo}/pulls/{n} -X PATCH -F body=@file` goes around it.

## Migrations

A migration in the branch means the deploy is not reversible by rolling the image back. Say so in
the PR body, and say whether it is additive (safe) or destructive (not) — see
[rollback.md](../../../docs/runbooks/rollback.md).

## Before asking for a merge

- CI is green. Fix failures that are regressions from `main`; say so if one isn't.
- Push anything still local.
- **Was there anything that would have made this work easier, or prevented a mistake?** If so, add
  it to `CLAUDE.md` or the relevant skill as part of this PR.
