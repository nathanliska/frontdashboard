---
name: "fdr"
description: "Write or revise a Feature Decision Record in docs/fdr/ — what a feature does behaviorally and the design decisions behind it. Use when a feature lands, changes behavior, or when asked to document how a feature works."
---

# Feature Decision Records

One record per feature: what it does from outside, and the design decisions that shaped it. An FDR
is the answer to "how is this supposed to behave, and why that way".

## What an FDR is not

The failure mode is an FDR that drifts into being one of these, and then rots:

- **Not a code walkthrough.** No file paths, function names or line numbers as structure. Name a
  module only where a reader genuinely cannot find it otherwise.
- **Not a changelog.** No "previously this did X". The record describes the feature as it is today;
  how it got there is in git.
- **Not a task list.** Deferred work belongs in [docs/TODO.md](../../../docs/TODO.md).
- **Not an ADR.** Cross-cutting decisions live in [docs/adr/](../../../docs/adr/INDEX.md); the FDR
  cites them. A decision local to this feature stays here.
- **Not a duplicate of CONTEXT.md**, which is the whole project's current-state snapshot.

## Before anything

Read [docs/fdr/INDEX.md](../../../docs/fdr/INDEX.md) for the table, the next free number and which
features already exist. A behavior change almost always belongs in an existing FDR — check before
creating one.

## Writing a new one

1. Take the next number from the INDEX table.
2. Create `FDR-{NNN}-{kebab-slug}.md` in the house shape:

```markdown
# FDR-{NNN}: {Feature Name}

**Status:** Active
**Last reviewed:** {YYYY-MM-DD}

## Overview

What the feature is and why it exists, in a short paragraph. What a user gets from it.

## Behavior

What it does, observably. The states, the transitions, what happens at the edges — empty, denied,
concurrent, offline. This is the longest section.

## Design Decisions

The choices that shaped it and the reason for each. Rejected alternatives belong here.

## Access

Who can see and do what — owner, editor, viewer, and what a non-member gets.

## Related

FDRs, ADRs and glossary terms this feature depends on or is depended upon by.
```

3. Add the row to the INDEX: `| [FDR-{NNN}](FDR-{NNN}-slug.md) | Feature Name | Active | {date} |`

## Revising one

Rewrite the affected section **in place** so the document still reads as a description of the
present. Then bump `**Last reviewed:**` in both the file and the INDEX row — a stale date is the
signal `doc-checkup` looks for, so leaving it is worse than the drift itself.

Cite any new ADR in `Related`. Citations flow FDR → ADR; the ADR never lists its FDRs.

## Writing quality

- Behavior belongs in the present indicative: "a viewer sees the layout but emits no writes".
- Prefer the invariant to the mechanism. "Access is inherited from the binding dashboard" survives a
  refactor; "`load_dashboard_access` is called in the router" does not.
- Coined a term? Add it to [docs/GLOSSARY.md](../../../docs/GLOSSARY.md) in the same change and link
  it back here.
