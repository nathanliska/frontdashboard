# Docs Overhaul — Design (2026-07-11)

## Goal
Make the repo's agent-facing documentation reflect reality and stay maintainable. The old
CLAUDE.md was a scaffold-era stub, CONTEXT.md was a build-step checklist frozen at "v1.0
complete" while v1.1 work (calendar, reminders, email flows) had already landed, and the
999-line PLAN.md had silently diverged from what was built.

## Decisions
- **CLAUDE.md** — rewritten as the "how to work in this repo" doc: architecture layers, the
  verification gate ("run before claiming done"), non-obvious conventions (the things that
  bite at runtime, mined from a code survey — not boilerplate), hard rules (standing user
  constraints), and a map of where to read more.
- **CONTEXT.md** — rewritten as a rolling *current-state* snapshot: what's built, what's in
  flight, what's deliberately deferred. Not a changelog; when a feature lands, its current
  behavior is folded into the right section rather than appended as a dated entry.
- **docs/ split by type** (create folders on first use, rule documented in CLAUDE.md):
  - `docs/references/` — standing policy and living reference docs (never "done").
  - `docs/designs/` — active/in-flight design docs.
  - `docs/shipped/` — full design docs for completed features (work closed).
- **PLAN.md → docs/references/original-plan.md** (`git mv`, history preserved) with a header
  marking it historical; CONTEXT.md is the source of current truth.
- **DESIGN_REVIEW.md → docs/references/review-findings.md** — becomes a rolling, dated review
  log (Pam-style): findings plus their dispositions (fixed / justified / deferred).

## Git workflow (corrected)
The old "no commits to main, enforced by branch protection" line was aspirational — branch
protection is not available on this repo's GitHub plan and no local hook blocks main. The
real workflow (sole contributor):
- Commit straight to `main`; no feature branches unless explicitly asked.
- Logical grouped commits — batch related work, don't micro-commit.
- **Always confirm before commit and before push** so the user can review files.
- Conventional Commits (hook-enforced); **no Co-Authored-By / attribution trailer**.

## Non-goals
- No content copied from other projects — structure inspiration only; every fact in the new
  docs comes from this repo's code, history, or the user.
- No README/user-facing docs rework beyond fixing links broken by the moves.
- No process ceremony beyond what a one-person project needs.
