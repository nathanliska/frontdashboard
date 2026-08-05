---
name: "adr"
description: "Write, amend or supersede an Architecture Decision Record in docs/adr/. Use when a cross-cutting architectural decision is made or changed, or when asked to record why the architecture is the way it is."
---

# Architecture Decision Records

An ADR records *why* a cross-cutting decision was made — the context that forced it, the choice, and
what it costs. It is not a description of the code, which is [CONTEXT.md](../../../CONTEXT.md), and
not a feature's behavior, which is an [FDR](../../../docs/fdr/INDEX.md).

**Cross-cutting is the test.** A decision that governs one feature belongs in that feature's FDR. A
decision several features must obey, or that a future change would be wrong to reverse unknowingly,
is an ADR.

## Before anything

Read [docs/adr/INDEX.md](../../../docs/adr/INDEX.md) — it carries the table of every ADR and the
next free number. Read individual ADRs only when they bear on the task.

## Writing a new one

1. Take the next number from the INDEX table. Numbers are never reused, including by superseded ADRs.
2. Create `ADR-{NNN}-{kebab-slug}.md` — a short slug for the decision, not the full title.
3. Follow the house shape exactly:

```markdown
# ADR-{NNN}: {Title}

**Date:** {YYYY-MM-DD}

## Context

What forced the decision. The constraint, the failure, or the thing that stopped scaling.

## Decision

What was chosen, stated so a reader can tell whether a future change violates it.

## Consequences

What this makes easy, what it makes hard, and what a caller now has to remember.
```

4. Add the row to the INDEX table: `| [ADR-{NNN}](ADR-{NNN}-slug.md) | Decision in one line | {date} |`
5. **FDR sweep.** Scan [docs/fdr/INDEX.md](../../../docs/fdr/INDEX.md) for features this decision now
   governs and add the citation to their `Related` section. Citations flow **FDR → ADR only** — an
   ADR never lists the FDRs that cite it.

## Amending one

Small corrections edit in place. A real change of substance appends to the `**Date:**` line in the
established form — `**Date:** 2026-07-20 (amended 2026-07-26 — what changed)` — so the record shows
its own history without a changelog section.

## Superseding one

Supersede, never delete: the old decision is why the code looked the way it did, and deleting it
strands every citation.

1. Write the new ADR, naming the one it replaces in its Context.
2. Note the replacement in the old ADR's Context or Decision — a reader who lands there must not act
   on it.
3. Add the new row to the INDEX. Leave the old row.
4. Run the FDR sweep for both.

## Writing quality

- One decision per ADR. Two decisions that could be reversed independently are two records.
- Record the alternatives that were rejected and why — that is the part a future reader needs and
  cannot reconstruct.
- Write so it stays true. An ADR that names a line number rots; one that names an invariant does not.
