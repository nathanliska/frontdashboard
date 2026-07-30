---
name: doc-checkup
description: Use when docs may have drifted from the code — after a run of feature commits, before relying on the ADRs/FDRs, or when CONTEXT.md, an ADR, an FDR, the glossary, or docs/TODO.md looks stale.
disable-model-invocation: true
---

# Doc checkup — drift audit (propose-only)

Audits the repo's agent docs against `git log` and the code. **Reports findings and proposed
edits; never applies them without explicit user direction.**

The doc system:
- **[AGENTS.md](../../../AGENTS.md)** — repo-wide agent instructions. The only file of its kind;
  `CLAUDE.md` is a symlink to it, and there are no per-stack variants.
- **[CONTEXT.md](../../../CONTEXT.md)** — current-state snapshot across the whole app.
- **[docs/adr/](../../../docs/adr/)** — Architecture Decision Records (*why* the cross-cutting
  architecture is the way it is). Living; supersede rather than delete.
- **[docs/fdr/](../../../docs/fdr/)** — Feature Decision Records (*what* each feature does + design
  rationale). Living; rewrite the affected section, don't append.
- **[docs/GLOSSARY.md](../../../docs/GLOSSARY.md)** — canonical vocabulary.
- **[docs/TODO.md](../../../docs/TODO.md)** — open remediation backlog (numbered findings).
- Closed work + execution detail live in **git history**, not in any doc.

## Checks

1. **CONTEXT.md vs. reality** — list commits since CONTEXT.md last changed
   (`git log --oneline $(git log -1 --format=%H -- CONTEXT.md)..HEAD`). Any feature/behavior
   change not folded into the right section? Any section describing removed behavior?
2. **ADR drift** — for each ADR, does the current code still reflect the recorded decision? Flag a
   **Contradiction** (code disagrees with an active ADR), a **Missing Supersession** (a newer
   decision replaced it but the old ADR doesn't say so), or a **Weak Decision** (no concrete choice
   recorded). Read related ADRs together when they form a chain.
3. **FDR drift** — for each FDR, verify its Behavior + Design Decisions against the code, its access
   notes against `app/models/share.py` / `app/services/permissions.py`, and that cited ADRs exist and
   still apply. Flag stale claims and significant user-facing behavior the FDR omits. Bump
   **Last reviewed** on any FDR proposed for edit, **and the matching row in `docs/fdr/INDEX.md`** —
   these drift apart silently, since nothing reads the index. Compare every row against its file's
   header, not just the ones being edited. ADRs date differently on purpose: the file header keeps
   the *original* decision date with `(amended …)` appended, and the index row shows the latest.
4. **Glossary** — cross-reference each entry against its cited FDR/ADR; flag dead links, definitions
   contradicted by code, and jargon used across multiple docs but missing an entry.
5. **TODO.md vs. `git log`** — any backlog item whose work appears shipped in recent commits (should
   be removed)? Any newly-introduced known gap not captured? Do the finding numbers still line up
   with references elsewhere?
6. **AGENTS.md facts** — spot-check verifiable claims (framework versions vs. lockfiles, `make`
   targets vs. Makefile, referenced paths exist). Apply the pruning test: flag lines whose removal
   would cause no mistakes. Flag any reference to a per-stack `CLAUDE.md`/`AGENTS.md`; those were
   removed, and their surviving rules belong in the root file's Backend/Frontend Principles.
7. **Link check** — relative doc links in AGENTS.md, CONTEXT.md, README.md, the skills under
   `.agents/skills/`, and the ADR/FDR indexes resolve.

## Output

One consolidated report: drift findings ranked by how misleading they are, each with the exact
proposed edit (and, for ADR/FDR findings, a category label). End by asking which to apply. When
applying: supersede ADRs (don't delete), rewrite FDR sections in place + bump **Last reviewed**, and
update the relevant INDEX.md if a title changed or a record was added.
