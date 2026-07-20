# ADR-009: Persisted Layout Is Canonical, Mobile View Is a Derived Projection

**Date:** 2026-07-20

## Context

react-grid-layout is a desktop, multi-column, drag-and-resize grid. On a narrow phone screen a
multi-column grid is unusable, so mobile needs a single-column stack. The danger: if the mobile view
*writes back* its own layout, opening a dashboard on a phone would flatten the carefully arranged
desktop grid into one column and persist that — destroying the desktop arrangement.

## Decision

The **persisted layout is canonical**; the **mobile view is a read-only derived projection**.

- Below 640px the grid renders a **computed one-column stack** derived from the persisted layout.
- **Layout events are ignored on mobile** (and on read-only dashboards), so the projection can never
  be written back and overwrite the desktop arrangement.
- Editable mobile layouts would require their own per-breakpoint persisted layout — **deliberately
  not built**.

## Consequences

- **Phones can't destroy the desktop layout**: the projection is display-only; there is no code path
  by which viewing on mobile mutates the stored grid.
- **Mobile arrangement is not independently editable**: you get the desktop order stacked, not a
  bespoke mobile order. Accepted deliberately; a per-breakpoint layout is the escape hatch if that
  changes.
- **The read-only-dashboard case rides the same rule**: viewers never emit layout writes, so the
  same guard that protects mobile also protects shared read-only dashboards.
- **"Canonical vs. projection" is a general framing**: it names the invariant clearly so future
  responsive work (a tablet breakpoint, say) knows it must either project read-only or introduce its
  own persisted layout — never write back into the canonical one.
