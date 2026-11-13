# ADR-009: Persisted Layout Is Canonical, the Stacked View Is a Derived Projection

**Date:** 2026-07-20 (amended 2026-08-19, 2026-08-21, 2026-09-06, 2026-11-06). The filename
keeps its original slug.

## Context

react-grid-layout is a desktop, multi-column, drag-and-resize grid. Below some width a multi-column
grid stops being usable and wants a single-column stack — a phone reaches that width first, but a
split-screen window on a large display reaches it too, and neither is a device the code should be
naming. The danger: if the stacked view *writes back* its own layout, opening a dashboard narrow
would flatten the carefully arranged grid into one column and persist that — destroying it.

## Decision

The **persisted layout is canonical**; the **stacked view is a read-only derived projection**; and
the canonical layout lives on **one bounded 24 x 24 grid**.

**Projection**

- Below `STACK_BELOW` the grid renders a **computed one-column stack** derived from the persisted
  layout. That threshold is the width at which a default four-column widget falls under 150px, not
  a device class — a split-screen window stacks for the same reason a phone does.
- **A stacked widget is capped at `STACK_MAX_ROWS`**, under one phone screen. A desktop height
  means nothing in one column: carried over, a calendar sized to fill a monitor stacked to several
  screens. Every widget scrolls inside itself, so the cap hides nothing.
- **Layout events are ignored while stacked** (and on read-only dashboards), so the projection can
  never be written back over the multi-column arrangement.
- Editing the stack would require its own per-breakpoint persisted layout — **deliberately not
  built**.

**Grid**

- **The grid is 24 x 24 at every width above the stack.** Only density (row height, margins) may
  vary with width, never the grid the layout is expressed in.
- **A board is one screen.** Row height is derived so 24 rows and their gaps fill the room below
  the grid, and nothing — drag, resize, collision push, or server-side placement — may leave the
  grid. Every rule below follows from that.
- **There is no minimum row height, and the gap gives way first.** The margin is capped at a third
  of a row, which is a no-op at 1440p and above.
- **Height is measured to the content box of the nearest scrolling ancestor**, and the row is
  floored rather than rounded.

**Writes**

- **A settled layout is in bounds and non-overlapping**, and that is what the client may adopt.
- **The write path enforces it, not the client.** `PUT /layout` rejects overlap as well as
  out-of-bounds.
- **A gesture whose result would leave the grid first re-seats every other widget** around the one
  being moved, all-or-nothing, and only when that fails does it revert — to the arrangement pinned
  when the gesture started.
- **A board that arrives already broken is repaired for display only**: every item is re-seated
  into the first free slot in reading order, and nothing is written back until the user makes a
  deliberate gesture.
- **A new widget takes the first free slot, and a full board is full.** An add takes the largest
  box up to the default that fits, never smaller than 4×4 cells for clock/list/agenda or 8×8 for
  calendar; a gap below that floor returns 409 and rolls back any resource created with the
  widget. Client resize constraints and the server layout write enforce the same limits. Existing
  smaller dimensions are grandfathered at their saved values, and enlarging a legacy widget raises
  its saved floor until it reaches the type minimum.

## Why

- **A remap is a trap.** The 640-959px band once rendered the canonical layout at half the column
  count. That is neither a read-only projection nor its own persisted layout: react-grid-layout
  resolves a remap by clamping every item whose `x + w` exceeds the column count, then reports
  those corrections through `onLayoutChange` indistinguishably from a drag. One touch on a tablet
  persisted the narrower arrangement over the canonical one.
- **Density is what a wider display gets.** A fixed column count means column width tracks the
  display without limit; with a fixed row ladder a four-column widget measured 328×356 at a 1280
  viewport and 1181×356 at 4K, a letterbox. Density costs no screen. Mobile is excluded: at one
  column the column *is* the viewport, so a row derived from it would be taller than the phone.
- **Both axes are hard bounds because neither used to be.** At 12 columns the horizontal step on
  a wide display was 191px, and with no row ceiling a widget pushed below the viewport kept going,
  which is how a board reached 56 rows of mostly empty space.
- **Row count is not a free parameter.** Cell ratio is `(working area aspect) x (rows / cols)`, so
  matching counts on a 1.9:1 working area gives roughly 2:1 cells; square cells would want ~13
  rows. 24 was chosen deliberately: the cell shape is invisible because a widget spans many, and
  the vertical step halves to 50px. Precision was the complaint; cell shape never was. The count
  fits one screen from a 1366x768 laptop to 4K, because those displays share an aspect ratio and
  the header and sidebar offsets scale roughly with them.
- **No row floor**, because a floor buys legibility by breaking the fit, and what has to stay
  legible is the widget, not the cell. Gaps are counted 23 times against rows counted 24, so a
  fixed 12px margin takes over half of a small laptop's height.
- **Changing either number is a data migration.** A coordinate is meaningless without the basis
  it counts in (`c7e1a9b3d5f8`). Columns doubled exactly, so `x`/`w` took the full factor. Rows
  could not: a board taller than half the new grid is scaled by whatever fits, which keeps every
  widget's share of the board where clamping each item alone would stack them. The migration seats
  items rather than clamping them, since clamping can leave an overlap the API now refuses.
- **The basis is one decision written twice.** The backend's `GRID_COLUMNS`/`GRID_ROWS` and the
  client's `DESKTOP_COLUMNS`/`DESKTOP_ROWS` are module constants, not schema fields, so the
  generated contract cannot carry them. `test_grid_basis_coverage.py` fails the build on drift,
  because the symptom otherwise is every gesture near an edge returning 422 far from its cause.
- **The server enforces overlap because the client is where the bug was.** A compactor that
  declines to settle reports widgets still on top of each other with every coordinate individually
  in range, so a bounds-only check stores a layout no client can render back — measured as
  `x:0 y:1 w:3 h:5` stored against `x:2 y:0 w:21 h:20`.
- **Re-seating exists because compaction settles upward**: it finds room above a widget and never
  beside it. On a full board, dragging a 20-wide widget to column 0 has an answer — the 4-wide
  column belongs at column 20 — and pushing down can never reach it. All-or-nothing, because a
  partial re-seat is how a widget lands somewhere nobody asked for.
- **The fallback is pinned at gesture start** because the library derives the drop placeholder
  from the layout it last rendered: a refusal freezes the placeholder, which is legible only if
  that is where the widget will land. A memory that outlives the gesture falls back to a drag two
  gestures ago and reads as the board rearranging itself.
- **A board can arrive already broken**, because the write path once accepted overlap: a layout
  stored before the check renders as stored, and on first render there is no earlier arrangement
  to fall back to. The display repair is the same first-free-slot scan the server places new
  widgets with.
- **Relocating is right for something new and wrong for something the user placed**, which is why
  an add re-homes freely and a displaced widget does not. Grandfathering follows: adopting a
  minimum must not force an old board into an overlapping arrangement.
- **The room below is not the window.** Width needs no arithmetic — the grid is `w-full` inside a
  padded `main`. Height is a measurement, and one against `window.innerHeight` accounts for
  everything above the grid and nothing below it, so the board ran flush to the bottom of the
  screen while its right edge kept the gutter. The scrolling ancestor's content box is the one box
  whose height the layout fixes rather than its contents. Flooring keeps 24 whole-pixel rows from
  spending room the fit just measured.

## How the bound is held

Three levers are needed for what looks like one behaviour:

| gesture | clamps the committed value | clamps what is drawn |
|---|---|---|
| drag | `gridBounds.constrainPosition` | wrapper `overflow: hidden` |
| resize | `gridBounds.constrainSize` | per-item `maxW` / `maxH` |

- **Without the second column a widget escapes on both axes** — measured 2394px past the bottom
  edge and 1180px past the right. The bottom is the visible one because overflow there grows the
  page's scroll height and buys room to keep going.
- **Collision resolution is not a gesture.** Widening a widget displaces what it lands on,
  downward, and `maxRows` cannot reach compaction, since `Compactor.compact(layout, cols)` is
  never handed it. So the bound lives in the compactor: `compact` is a prop, and the wrapper
  rejects any settlement that reaches past the last row, returning the last arrangement that fit.
  Push is kept, which is what lets two widgets swap.
- **Only a settled layout can be judged.** What react-grid-layout hands to `onDrag`/`onResize` is
  `moveElement`'s output — pushed aside but not yet compacted — so overlap and overrun are
  ordinary states in it. Warning from that layout flagged 20 of a successful reorder's 30 frames,
  and 0 once settled first. The compactor and the warning share one settle step, so they cannot
  disagree about what the grid will accept.
- **A refusal remounts the grid.** Refusing the result in `onLayoutChange` suppresses the save but
  not the render: the library re-syncs from the `layout` prop only when it deep-differs from the
  last one, and a refusal leaves it unchanged. So a refusal bumps a nonce used as the grid's key.
  Affordable because refusal is the exceptional path.
- **The last arrangement that fit is kept as a copy.** What the compactor returns becomes the
  library's own layout, and `moveElement` edits those items in place on the next frame — so
  holding the reference lets the drag rewrite the record of what fit. Measured as the whole board
  sliding a row down mid-gesture.
- **Candidate slots for an add are the existing items' edges**, not every cell: a slot that fits
  at all fits flush against something's bottom or right, or against an axis. Candidates are
  ordered by area and then default aspect ratio. There is no below-everything fallback, because
  there is no below.

## Rejected alternatives

- **Capping the page width**: at 1600px it left 678px of gutter on a 2550px display to save 190px
  of widget.
- **Making the row follow the column**: it squared the cell only where the display had headroom,
  so cells stayed near 2:1 while the code gained a second constraint.
- **`dragConfig.bounded`**: it clamps the dragged element to the board's height, and
  react-grid-layout decides a swap by how far that element has travelled past the midpoint of what
  it overlaps. A tall neighbour's midpoint lies beyond where the item may legally land, so
  reordering downward is disabled outright — measured, the element stopped at row 12 against a
  midpoint at row 17, and the drop placeholder never left row 0. Clipping the wrapper gives no
  page growth during a gesture (0 against
  1088px) at no cost in travel.
- **`preventCollision`**: bounds the grid but costs every reorder, since a widget can then never
  be displaced.
- **Free placement (`noCompactor`)**: does not restore the downward drag, and let a widget
  overflow 592px, because the push happens where the wrapper cannot see it.
- **Clamping a broken board into range**: satisfies the bounds and leaves the widgets stacked.
- **Migrating to GridStack**, which has a native `maxRow`, an explicit `swap()` and a
  simulate-then-apply move check: its `maxRow` carries open issues of exactly the kind fixed here,
  so the trade is tested patches for untested equivalents plus an imperative library's state-sync
  surface in React. This ADR is the requirement list that would make a later migration cheap.

## Consequences

- **A narrow window can't destroy the layout**: there is no code path by which viewing the stack
  mutates the stored grid.
- **The stacked arrangement is not independently editable**: you get the canonical order stacked,
  not a bespoke narrow one. A per-breakpoint layout is the escape hatch if that changes.
- **The read-only-dashboard case rides the same rule**: the guard that protects the stack also
  protects shared read-only dashboards.
- **"Canonical vs. projection" is a general framing**: future responsive work must either project
  read-only or introduce its own persisted layout — never write back into the canonical one.
- **Cells are about 2:1**, traded for a 50px vertical step.
- **Reordering is asymmetric, and that is the compaction model rather than the bound.** Widgets
  settle upward, so a downward drag has to overshoot: passing a taller neighbour costs the height
  difference in extra travel. Measured on a full board, an 8-row widget above a 10-row one moved
  nothing when dragged down 5 rows or 8, and swapped at 10; identical with the bound removed.
  Charging both directions the same travel means explicit swap semantics, not a config flag.
- **Refusing stays the honest answer when the board has no room**: one column further in, the same
  20-wide drag leaves a 2-wide strip on each side, and no re-seat can rescue it.
