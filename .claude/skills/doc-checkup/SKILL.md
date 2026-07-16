---
name: doc-checkup
description: Use when docs may have drifted from the code — before closing a remediation phase, after a run of feature commits, or when CONTEXT.md, review-findings.md, or a design doc looks stale.
disable-model-invocation: true
---

# Doc checkup — drift audit (propose-only)

Audits the repo's agent docs against `git log` and the code. **Reports findings and proposed
edits; never applies them without explicit user direction.**

## Checks

1. **CONTEXT.md vs. reality** — list commits since CONTEXT.md last changed
   (`git log --oneline $(git log -1 --format=%H -- CONTEXT.md)..HEAD`). Any feature/behavior
   change not folded into the right section? Any section describing removed behavior?
2. **`docs/designs/` staleness** — for each doc: does its work appear shipped in `git log`?
   If fully done, propose: flip `Status:` line (date + SHAs) and `git mv` to `docs/shipped/`.
   A design doc must have a `Status:` line; propose adding one if missing.
3. **Review tracker vs. `git log`** — in `docs/references/review-findings.md`, verify every
   cited SHA exists, every "Done" disposition has a phase-table row and changelog entry that
   agree, and no shipped fix is missing its disposition.
4. **CLAUDE.md facts** — spot-check verifiable claims (framework versions vs. lockfiles,
   `make` targets vs. Makefile, referenced paths exist) in root + `backend/` + `frontend/`
   CLAUDE.md. Apply the pruning test: flag lines whose removal would cause no mistakes.
5. **Link check** — relative doc links in CLAUDE.md, CONTEXT.md, README.md resolve.

## Output

One consolidated report: drift findings ranked by how misleading they are, each with the
exact proposed edit. End by asking which to apply.
