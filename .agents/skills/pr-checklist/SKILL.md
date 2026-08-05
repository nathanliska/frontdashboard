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
  the former, the `PR title` workflow the latter, rechecking whenever the title is edited.

## Tests

- Are there gaps around new or changed behavior? Fill them.
- **Prove each new test by breaking the thing back**: stash the change, watch it fail, restore. A
  caching, ordering or fan-out test that has never been seen to fail is not evidence.
- If the change alters *how* a result is produced rather than *what* it is, assert on the mechanism
  — a call count, `getState` — not the result, which passes against the unfixed code.
- Run what would actually catch a regression here: `make test`, or the narrower suite plus a reason.

## The conventions that fail the build

Each of these has a test that fails CI when missed. Check the ones the diff touches:

- Every non-GET route: `_csrf: None = Depends(require_csrf)` **and** `@limiter.limit(WRITE_LIMIT)`
  with a `request: Request` parameter.
- Auth rejections raise `auth_failure(...)`, never a bare `HTTPException`.
- SSE writes go through `commit_and_broadcast(...)`, with the event dict built *before* the call.
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
- **AGENTS.md** for a new standing rule or gotcha. Edit it by that name — `CLAUDE.md` is a symlink
  and tools refuse to write through it.
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
Scale the length to the change — **~800 characters for a small one, ~2000 for a large one** — with
one-line bullets carrying one fact each. Three headings always, in this order:

- **Why** — a short paragraph: the problem, and what should be true instead.
- **What changed** — one bullet per change. What it does now, not a walk through the diff.
- **Test plan** — `command — result, with numbers`, and what is still unverified.

`.github/pull_request_template.md` also prefills **Compatibility** above Test plan — a migration,
a regenerated contract, or a change to auth, sharing, SSE audience or retention. Keep the lines
that apply; delete the whole section when only "No behavior change for existing clients" survives,
because a section reading "not applicable" is noise.

Then cut every sentence narrating _how_ the problem was found — root-cause derivations, measurement
tables, why it passed once. That is commit-body and issue material; one sentence in **Why** at most.
Caveats and unrelated defects go to the user in conversation or become their own issue, never a
section here. Link the ADRs, FDRs and TODO findings involved. Use `Closes #123.` when it closes an
issue.

For multiline bodies with `gh`, write Markdown to a file and use `--body-file` — never escaped `\n`
in `--body`. Afterwards, read it back with
`gh pr view --json title,body,baseRefName,isDraft` and confirm it matches the diff.

## Migrations

A migration in the branch means the deploy is not reversible by rolling the image back. Say so
under **Compatibility**, and say whether it is additive (safe) or destructive (not) — see
[rollback.md](../../../docs/runbooks/rollback.md).

## Before asking for a merge

- CI is green. Fix failures that are regressions from `main`; say so if one isn't.
- Push anything still local.
- **Count the body before asking, not after.** ~800 characters for a small change, ~2000 for a
  large one, and the headings above. Over the ceiling means cutting the investigation, not facts.
- **Read the commit list as a reviewer meeting it fresh** — one decision each, and no commit
  fixing a defect another commit in this same branch introduced. Fold those into the commit they
  fix, rewriting the branch if it is already pushed. A bug and its fix both reaching `main`'s
  history is noise a reviewer has to untangle later.
- **Was there anything that would have made this work easier, or prevented a mistake?** If so, add
  it to `AGENTS.md` or the relevant skill as part of this PR.
