# ADR-009: Persisted Layout Is Canonical, the Stacked View Is a Derived Projection

**Date:** 2026-07-20 (amended 2026-08-19 — the canonical grid is 24 x 24 and both axes are hard
bounds; amended 2026-08-21 — the write path enforces the invariant, and a refusal makes room
sideways before it reverts; amended 2026-08-21 — the projection triggers on a width rather than a
device class, and this ADR was retitled to match. The filename keeps its original slug.)

## Context

react-grid-layout is a desktop, multi-column, drag-and-resize grid. Below some width a multi-column
grid stops being usable and wants a single-column stack — a phone reaches that width first, but a
split-screen window on a large display reaches it too, and neither is a device the code should be
naming. The danger: if the stacked view *writes back* its own layout, opening a dashboard narrow
would flatten the carefully arranged grid into one column and persist that — destroying it.

## Decision

The **persisted layout is canonical**; the **stacked view is a read-only derived projection**.

- Below `STACK_BELOW` the grid renders a **computed one-column stack** derived from the persisted
  layout. That threshold is the width at which a default four-column widget falls under 150px, not
  a device class — a split-screen window stacks for the same reason a phone does.
- **Layout events are ignored while stacked** (and on read-only dashboards), so the projection can
  never be written back and overwrite the multi-column arrangement.
- Editing the stack would require its own per-breakpoint persisted layout — **deliberately not
  built**.

## Consequences

- **A narrow window can't destroy the layout**: the projection is display-only; there is no code
  path by which viewing it stacked mutates the stored grid.
- **The stacked arrangement is not independently editable**: you get the canonical order stacked,
  not a bespoke narrow one. Accepted deliberately; a per-breakpoint layout is the escape hatch if
  that changes.
- **The read-only-dashboard case rides the same rule**: viewers never emit layout writes, so the
  same guard that protects the stack also protects shared read-only dashboards.
- **"Canonical vs. projection" is a general framing**: it names the invariant clearly so future
  responsive work (a tablet breakpoint, say) knows it must either project read-only or introduce its
  own persisted layout — never write back into the canonical one.
- **A third option is a trap, and it had already been taken (#53, fixed 2026-07-26).** The 640-959px
  band rendered the canonical layout at half the column count. That is neither a read-only
  projection nor its own persisted layout — it is a *remap*, and react-grid-layout resolves a remap
  by clamping every item whose `x + w` exceeds the column count, then reporting those corrections
  through `onLayoutChange` indistinguishably from a drag. One touch on a tablet persisted the
  narrower arrangement over the canonical one. The column count is therefore the same at every
  width above the stacking threshold: **only density (row height, margins) may vary with width,
  never the grid the layout is expressed in.**
- **So density is what a wider display gets** (amended 2026-08-19). A fixed column count means column
  width tracks the display without limit, and `rowHeight` was a fixed ladder ending at 80 — so a
  four-column widget measured 328×356 at a 1280 viewport and **1181×356 at 4K**, growing wider
  without growing taller until every card was a letterbox. Capping the page's width was tried first
  and rejected: at 1600px it left 678px of gutter on a 2550px display to save 190px of widget,
  trading one complaint for a worse one. Density is the lever this ADR already sanctions, and unlike
  a cap it costs no screen.

  Making the row follow the *column* was tried next and is also superseded. It squared the cell up
  only where the display had headroom, so on the common case the viewport still bound the row and
  cells stayed near 2:1 — the complaint went unfixed while the code gained a second constraint to
  reason about. **Mobile stays excluded from any of this**: at one column the column *is* the
  viewport, so a row derived from it would be taller than the phone.

- **The canonical grid is 24 x 24, and both axes are hard bounds** (amended 2026-08-19). Columns
  were 12 and rows were not a concept at all: the client sized rows so eleven filled the viewport,
  but nothing stopped a layout growing past that. Two consequences followed, and both were bugs.
  The horizontal step on a wide display was 191px, so the smallest possible nudge moved a widget a
  twelfth of the board. And a widget pushed below the viewport had no ceiling to stop it, which is
  how a board reached 56 rows of mostly empty space.

  **A board is one screen.** Row height is derived so 24 rows and their gaps fill the room below the
  grid, and nothing — drag, resize, collision push, or server-side placement — may leave the grid.
  That is the whole model, and every rule below is a consequence of it rather than a separate
  decision.

  **Row count is not a free parameter.** Cell ratio is `(working area aspect) x (rows / cols)`, so
  matching the counts on a 1.9:1 working area gives 1.9:1 cells — the letterboxing the doubling was
  meant to fix. Square cells would want ~13 rows. 24 was chosen over that deliberately: cells are
  about 2:1, which is invisible because a widget spans many of them, and in exchange the vertical
  step halves to 50px. Precision was the actual complaint; cell shape never was. The count fits one
  screen from a 1366x768 laptop to 4K, because those displays share an aspect ratio and the header
  and sidebar offsets scale roughly with them.

  **There is no minimum row height, and the gap gives way first.** A floor would buy legibility by
  breaking the fit, and what has to stay legible is the widget, not the cell. Gaps are counted 23
  times against rows counted 24, so a fixed 12px margin takes over half of a small laptop's height;
  the margin is capped at a third of a row instead, which is a no-op at 1440p and above.

  **Changing either number is a data migration.** A coordinate is meaningless without the basis it
  counts in (`c7e1a9b3d5f8`). Columns doubled exactly, so `x`/`w` take the full factor. Rows could
  not: a board taller than half the new grid cannot double without spilling out, so it is scaled by
  whatever does fit, which keeps every widget's share of the board where clamping each item alone
  would silently stack them. It follows that the backend's `GRID_COLUMNS`/`GRID_ROWS` and the
  client's `DESKTOP_COLUMNS`/`DESKTOP_ROWS` are one decision written twice, with nothing in the type
  system linking them — they are module constants, not schema fields, so the generated contract
  cannot carry them. `test_grid_basis_coverage.py` fails the build on drift, because the symptom
  otherwise is every gesture near an edge returning 422 far from the edit that caused it.

- **A gesture is bounded, and so is its consequence** (amended 2026-08-19). Three different levers
  are needed for what looks like one behaviour, and each was missing:

  | gesture | clamps the committed value | clamps what is drawn |
  |---|---|---|
  | drag | `gridBounds.constrainPosition` | wrapper `overflow: hidden` |
  | resize | `gridBounds.constrainSize` | per-item `maxW` / `maxH` |

  Only the first column was in place, so a widget followed the cursor 2394px past the bottom edge
  and snapped back on release. That reads as a vertical-only fault and is not one — it escapes on
  both axes, measured at 1180px past the right edge too. The right edge merely *feels* solid because
  the screen runs out there, while an element overflowing the bottom grows the page's scroll height
  and buys room to keep going.

  **`dragConfig.bounded` is the wrong lever for the drag, and the reason is structural.** It clamps
  the dragged element to the board's current height, and react-grid-layout decides a swap by how far
  that *element* has travelled — past the midpoint of whatever it overlaps. The midpoint of a tall
  neighbour lies beyond where the item may legally land, so bounding the travel disables reordering
  downward outright: measured, the element stopped at row 12 against a midpoint at row 17 and the
  drop placeholder never left row 0. Clipping the wrapper achieves what `bounded` was added for —
  no page growth during a gesture, measured at 0 against 1088px — while costing no travel.

  Bounding the gesture is still not enough, because **collision resolution is not a gesture**.
  Widening a widget displaces whatever it lands on, vertical compaction is the only axis available,
  so the displaced item goes down — and compaction is the one thing `maxRows` cannot reach, since
  `Compactor.compact(layout, cols)` is never handed it.

  Refusing the *result* in `onLayoutChange` suppresses the save but not the render, which is worth
  recording because it looks like it should do both. The library re-syncs from the `layout` prop only
  when that prop deep-differs from the prop it last saw, and a refusal by definition leaves the prop
  unchanged — so no sync happens and the board goes on showing an arrangement that was never stored.
  A refusal therefore also bumps a nonce used as the grid's key, remounting it against the stored
  layout. That is affordable exactly because refusal is the exceptional path.

  **A board can arrive already broken, so refusing is not enough — it has to be repairable.** The
  write path has never rejected overlap, so a layout stored before this existed renders exactly as
  stored, and on first render there is no earlier arrangement to fall back to. Clamping each item
  into range satisfies the bounds and leaves the widgets stacked permanently. So the fallback
  re-seats every item into the first free slot that holds it, in reading order — the same scan the
  server places new widgets with. It repairs for *display* only: nothing is written back until the
  user makes a deliberate gesture, so a board is never silently rearranged on being opened.

  **A refused settlement is not merely out of bounds — it is unsettled.** Widgets the compactor
  declined to move apart are still on top of each other, and their coordinates are individually in
  range, so a bounds-only check adopts them. The write path does not check overlap either, so two
  widgets reached the database stacked in the same cells: pulling a wide widget left over a narrow
  one stored `x:0 y:1 w:3 h:5` against `x:2 y:0 w:21 h:20`. What the client may adopt is therefore
  defined as *in bounds and non-overlapping*, which is the real invariant a settled layout has.

  So the bound lives in the compactor itself: `compact` is a prop, and wrapping it means rejecting
  any settlement that reaches past the last row — returning the last arrangement that fit, so the
  gesture reverts rather than half-applying. Push is kept, which matters because push is what lets
  two widgets swap. `preventCollision` bounds the grid too and was tried: it costs every reorder,
  since a widget can then never be displaced at all. Free placement (`noCompactor`) was also tried
  and is worse on both counts — it does not restore the downward drag, and it let a widget overflow
  592px, because with nothing to compact the push happens where the wrapper cannot see it.

  **Reordering is asymmetric, and that is the compaction model rather than the bound.** Widgets
  settle upward, so a downward drag has to overshoot: the neighbour is pushed *up* to the target row
  minus its own height, and the drag does nothing at all until that leaves room for it above. Passing
  a taller neighbour therefore costs the height difference in extra travel. Measured on a full board,
  an 8-row widget 8 rows above a 10-row one moved nothing when dragged down 5 rows or 8, and swapped
  the pair at 10; dragging the lower one up swaps at the distance it looks like it should. Measured
  identically with the bound removed, so it predates all of this. Charging both directions the same
  travel means explicit swap semantics, not a config flag.

- **The write path is what enforces the invariant, not the client** (amended 2026-08-20). `PUT
  /layout` rejects overlap as well as out-of-bounds. The two failures look different and are the
  same: a client whose compactor declines to settle an arrangement reports one where widgets still
  sit on each other, and every coordinate in it is individually in range — so a bounds-only check
  stores a layout no client can render back. That is a corruption a client-side check cannot be
  trusted to prevent, because the client is where the bug was. Migration `c7e1a9b3d5f8` therefore
  seats items rather than clamping them: clamping satisfies the bounds while leaving an overlap,
  which would store data the API itself now refuses.

  Staying on react-grid-layout was weighed against migrating to GridStack, which has a native
  `maxRow`, an explicit `swap()`, and a simulate-then-apply move check. It was rejected on evidence:
  GridStack's `maxRow` carries open issues of exactly the kind fixed here — a drag pushing past the
  limit, items landing wrong with it set, items leaving the grid — so the trade is tested patches
  for untested equivalents, plus an imperative library's state-sync surface in React. What this ADR
  now records *is* the requirement list, which is what would make a later migration cheap.

- **Only a settled layout can be judged** (amended 2026-08-20). The layout react-grid-layout hands
  to `onDrag`/`onResize` is `moveElement`'s output — collisions resolved by pushing neighbours
  aside, but not yet compacted — so overlap and overrun are ordinary states in it, and the settled
  arrangement is computed only afterwards. Warning the user from that layout marks nearly every
  gesture undroppable: measured on a full board, a reorder that succeeded and saved was flagged on
  20 of its 30 frames, and 0 once settled first. The compactor and the warning therefore share one
  settle step, so they cannot disagree about what the grid will accept.

  **Compaction settles upward, so it finds room above a widget and never room beside it.** That is
  not a tuning problem: on a full board, dragging a 20-wide widget to column 0 has an answer — the
  4-wide column belongs at column 20 — and pushing down can never reach it, so the settlement
  overruns and the drag is refused against plain evidence that it fits. A refusal therefore first
  re-seats every *other* widget around the one the gesture is moving, and takes that arrangement if
  it holds. All-or-nothing: a partial re-seat is how a widget lands somewhere nobody asked for, and
  refusing stays the honest answer when the board has no room — one column further in, the same drag
  leaves a 2-wide strip on each side, and no re-seat can rescue it.

  A refusal has a second cost that is easy to miss: the library derives the drop placeholder from
  the layout it last rendered, so declining to advance that layout freezes the placeholder where the
  gesture last succeeded while the widget goes on following the cursor. That is legible only if the
  frozen position is where the widget will actually land — which makes *which* arrangement a refusal
  falls back to load-bearing. It is pinned when the gesture starts, because the memory of the last
  one that fit outlives every gesture, and falling back to a drag two gestures ago reads as the
  board rearranging itself.

  That memory is kept as a copy, never as the array handed back. What the compactor returns becomes
  the library's own layout, and `moveElement` edits those items in place on the next frame rather
  than replacing them — so holding the reference lets the drag quietly rewrite the record of what
  fit, and the refusal then restores an arrangement the drag itself invented. Measured as the whole
  board sliding a row down mid-gesture and holding there until the drop snapped it back.

- **A new widget takes the first free slot, and a full board is full** (amended 2026-08-19).
  Placing each addition below all the others grew a board by one widget's height per add and left
  every other column empty. Candidate positions are the existing items' edges rather than every
  cell, since a slot that fits at all fits flush against something's bottom or right, or against an
  axis. There is no below-everything fallback, because there is no below. Relocating is right when
  placing something new and wrong when preserving something the user placed, which is why an add
  re-homes freely and a displaced widget does not.

  **The default size is a preference, not a requirement.** Asking only for that exact box reported a
  full board while an eighth of the grid stood empty — a gap one row short of the default is
  ordinary. So an add takes the largest box up to the default that fits, and only a board without a
  single free cell is refused with a 409. Shrinking has no floor: the grid is bounded, so even a 1x1
  result is on screen and can be dragged bigger, which beats refusing the add outright. Candidates
  are ordered by area rather than shrunk one axis at a time, because giving up the longer side first
  leaves a tall narrow gap holding a 3x3 where a 3x9 fits — 51 wasted cells, measured.

- **The room below is not the window, and that asymmetry is visible** (amended 2026-08-19). Width
  needs no arithmetic: the grid is `w-full` inside a padded `main`, so CSS subtracts the page gutter
  on both sides for free. Height goes around CSS to a measurement, and a measurement against
  `window.innerHeight` accounts for everything *above* the grid and nothing below it — so the board
  ran to the last pixel of the window with its bottom edge flush against the screen while its right
  edge kept the 24px gutter. Height is therefore measured to the **content box of the nearest
  scrolling ancestor**: that is the one box whose height the layout fixes rather than its contents,
  and stopping at its content box is what makes the page's bottom padding count the way `w-full`
  already makes its side padding count. The row is floored rather than rounded for the same reason —
  24 whole-pixel rows rounded up spend room the fit just finished measuring.
