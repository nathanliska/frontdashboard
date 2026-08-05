---
name: "glossary"
description: "Look up, add or audit a term in docs/GLOSSARY.md — the project's canonical vocabulary across UI, Product, Access and Backend. Use when a term is coined or renamed, when a word is being used two ways, or when auditing the glossary against the code."
---

# Glossary

[docs/GLOSSARY.md](../../../docs/GLOSSARY.md) is the canonical vocabulary. Its job is to stop one
concept being called three things — in the UI, in the API, and in conversation.

## What belongs in it

A term earns an entry when it is **project-specific** and **load-bearing**: someone reading the code
or a doc would otherwise guess wrong. `ResourceShare`, `Inherited access`, `Owner` — each has a
precise meaning here that the plain English word does not carry.

Not general programming vocabulary, not a restatement of a type, and not a place for behavior —
behavior belongs in the owning [FDR](../../../docs/fdr/INDEX.md), which the entry links to.

## Sections

Four, in this order, and entries go in the one matching how the reader meets the term:

- **UI** — what a person sees and clicks.
- **Product** — the concepts the product is built from.
- **Access** — sharing, roles and permission vocabulary.
- **Backend** — server-side machinery a caller has to know by name.

Within a section, order **conceptually**, not alphabetically: the term a reader needs first comes
first, and terms that only make sense together sit together.

## Entry format

```markdown
**Term** — Definition in one or two sentences, stating the invariant a reader could get wrong.
See [FDR-004](fdr/FDR-004-sharing-and-access.md).
```

A role or type may carry a parenthetical qualifier — `**Editor** *(role)*`. Link the FDR or ADR that
owns the concept whenever one exists; a term with no owning document is usually a term that needs
one written.

## Adding or renaming

1. Read the section first — the term may exist under another name, which makes this a rename.
2. Write the entry in the section and position where a reader would look for it.
3. Cross-link: the owning FDR/ADR gains the term, the entry gains the link.
4. **On a rename, sweep the old word repo-wide** — `grep -rni` across `docs/`, `AGENTS.md`, code
   comments and UI strings. Recall misses FDR bodies and ADR titles; the grep does not.

## Auditing

Work in both directions, and report rather than mass-edit:

- **Glossary → code**: does each term still exist under that name? A term whose code identifier was
  renamed is the highest-value finding here.
- **Code → glossary**: scan model names, role enums, event type names and UI labels for concepts
  used repeatedly with no entry.
- **Consistency**: one concept, one name. Two entries meaning the same thing is a finding; so is one
  word used for two concepts in different sections.
- **Dead links**: every `See [FDR-NNN]` / `[ADR-NNN]` resolves, and the cited document still covers
  the term.
