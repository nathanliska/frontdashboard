import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { GridLayout, type Layout, verticalCompactor } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { Dashboard, DashboardWidget, LayoutItem } from '../../api/dashboards'
import type { LayoutGesture } from '../../api/generated/contract'
import { useAvailableHeight, useContainerSize } from '../../hooks/useContainerSize'
import { confirm } from '../../stores/confirm'
import { useDashboardStore } from '../../stores/dashboard'
import { WidgetContainer } from './WidgetContainer'

// The canonical grid every persisted layout counts in, mirroring the backend's GRID_COLUMNS and
// GRID_ROWS — `test_grid_basis_coverage.py` fails the build when either drifts, because a layout
// written against a larger one is rejected by the write path rather than degraded.
const DESKTOP_COLUMNS = 24
const DESKTOP_ROWS = 24
// A row is a 24th of the room below the grid rather than a fixed height, which is what makes "one
// screen" true. No floor: a widget spans many rows, so what must stay legible is it, not the cell.
const MIN_ROW_HEIGHT = 1
// Gaps are counted 23 times against a row counted 24, so a fixed margin eats a small display: 12px
// leaves over half of a 1366x768 laptop's height as gutter. Held to a third of a row instead, which
// is a no-op at 1440p and above and keeps rows usable below it.
const MAX_MARGIN = 12
// Where the board stops being a board: a default 4-column widget is (width - 276) / 6 + 36 px, so
// this is the point it falls under 150px. Held on past it, six slivers beat one readable column
// (ADR-009).
const STACK_BELOW = 960
// A stack's row unit rather than a share of the screen, since its height is the scroll, not the
// viewport. Sized so a default widget clears 250px — a split-screen window stacks, not just a phone.
const STACK_ROW_HEIGHT = 36

function sameOccupants(a: Layout, b: Layout): boolean {
  if (a.length !== b.length) return false
  const ids = new Set(a.map((item) => item.i))
  return b.every((item) => ids.has(item.i))
}

/**
 * Whether `layout` is one this dashboard may adopt: inside the grid, and not self-overlapping.
 *
 * Bounds alone are not enough. When the compactor refuses a settlement that would overflow, the
 * arrangement the library reports has *not* been settled — widgets that compaction would have moved
 * apart are still on top of each other. Those coordinates are individually in range, so a bounds
 * check waves the overlap through and it reaches the write path, which rejects the whole layout.
 */
function isAdoptable(layout: Layout, cols: number, rows: number): boolean {
  const inBounds = layout.every(
    (item) => item.x + item.w <= cols && item.y + item.h <= rows && item.x >= 0 && item.y >= 0,
  )
  if (!inBounds) return false

  return layout.every((item, index) =>
    layout.every(
      (other, otherIndex) =>
        index === otherIndex ||
        item.x >= other.x + other.w ||
        other.x >= item.x + item.w ||
        item.y >= other.y + other.h ||
        other.y >= item.y + item.h,
    ),
  )
}

/**
 * First free position for a `w` x `h` box among `placed`, or null when nothing holds it.
 *
 * Candidates are the occupied edges, the same scan the server places new widgets with.
 */
function firstFreeSlot(
  placed: Layout,
  w: number,
  h: number,
  cols: number,
  rows: number,
): { x: number; y: number } | null {
  const candidateRows = [0, ...placed.map((other) => other.y + other.h)].sort((a, b) => a - b)
  const candidateCols = [0, ...placed.map((other) => other.x + other.w)].sort((a, b) => a - b)

  for (const y of candidateRows) {
    if (y + h > rows) continue
    for (const x of candidateCols) {
      if (x + w > cols) continue
      const clear = placed.every(
        (other) =>
          x >= other.x + other.w || other.x >= x + w || y >= other.y + other.h || other.y >= y + h,
      )
      if (clear) return { x, y }
    }
  }
  return null
}

/**
 * Re-seat every item into the first free slot that holds it, in reading order.
 *
 * The repair path for a layout that overlaps or overruns the grid. Such a layout can be *stored* —
 * the write path rejected overlap only from this release on — so a board can arrive already broken,
 * and clamping each item on its own satisfies the bounds while leaving widgets sat on top of one
 * another. Clamping is still the last resort here, because a repair has to return something.
 */
function repack(layout: Layout, cols: number, rows: number): Layout {
  const placed: Layout[number][] = []

  for (const item of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const w = Math.min(item.w, cols)
    const h = Math.min(item.h, rows)
    const seat = firstFreeSlot(placed, w, h, cols, rows) ?? { x: 0, y: Math.max(0, rows - h) }
    placed.push({ ...item, ...seat, w, h })
  }

  return placed
}

/**
 * Re-seat everything *except* `pinned` around it, or null if that leaves someone homeless.
 *
 * Compaction only settles upward, so it finds room the gesture opened above a widget and never room
 * beside it. Dragging a full-width widget across a full board is the case: there is an arrangement
 * that holds — it just needs a neighbour to move sideways, which pushing down can never discover, so
 * the settlement overruns and the drag is refused against plain evidence that it fits.
 *
 * All-or-nothing on purpose. A partial re-seat is how a widget ends up somewhere nobody asked for,
 * and refusing is the honest answer whenever the board genuinely has no room for the gesture.
 */
function repackAround(layout: Layout, cols: number, rows: number, pinned: string): Layout | null {
  // The pin is taken as given, so it is the one item a free-slot scan never vets. Everything else
  // is seated clear of what is already down, which leaves the result adoptable by construction.
  const pin = layout.find((item) => item.i === pinned)
  if (!pin || !isAdoptable([pin], cols, rows)) return null

  const placed: Layout[number][] = [{ ...pin }]
  for (const item of layout
    .filter((other) => other.i !== pinned)
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const slot = firstFreeSlot(placed, item.w, item.h, cols, rows)
    if (!slot) return null
    placed.push({ ...item, ...slot })
  }

  return placed
}

/**
 * Settle a layout the way the grid will, and report whether the result is one the grid can take.
 *
 * Shared so the drag feedback and the compactor cannot disagree. What react-grid-layout hands to
 * `onDrag`/`onResize` is `moveElement`'s output — collisions resolved by pushing neighbours aside,
 * but not yet compacted — so overlap and overrun are ordinary states there, and judging it directly
 * calls almost every gesture blocked. Only the settled arrangement answers the question.
 *
 * Cloned on the way in because compaction mutates the items it has not reached yet, through
 * `resolveCompactionCollision`. This runs on the live layout mid-gesture, which is not ours to edit.
 */
function settle(layout: Layout, cols: number, rows: number): { settled: Layout; fits: boolean } {
  const settled = verticalCompactor.compact(
    layout.map((item) => ({ ...item })),
    cols,
  )
  return { settled, fits: isAdoptable(settled, cols, rows) }
}

/**
 * Settle `layout`, and say which arrangement the grid would take for it — null if it has no room.
 *
 * One decision, so what the warning paints and what the compactor returns cannot disagree. The
 * settlement comes back either way, because a refusal still needs it to tell which board it is
 * looking at.
 */
function resolve(
  layout: Layout,
  cols: number,
  rows: number,
  pinned: string | null,
): { settled: Layout; taken: Layout | null } {
  const { settled, fits } = settle(layout, cols, rows)
  if (fits) return { settled, taken: settled }

  return { settled, taken: pinned === null ? null : repackAround(settled, cols, rows, pinned) }
}

/**
 * Vertical compaction that rejects any settlement reaching past the last row.
 *
 * `Compactor.compact(layout, cols)` is never handed `maxRows`, so displacing a neighbour is the one
 * way a widget leaves a bounded grid — and it cannot be caught downstream, because the library
 * re-syncs from the `layout` prop only when that prop deep-differs from the prop it last saw.
 * Catching it here keeps push, which is what makes two widgets swap when there is room for it;
 * forbidding collisions outright bounds the grid too, but at the cost of every reorder.
 */
function useBoundedCompactor(rows: number) {
  const lastFitting = useRef<Layout | null>(null)
  const moving = useRef<string | null>(null)

  return useMemo(
    () => ({
      ...verticalCompactor,
      /**
       * Note which widget the gesture is moving, and the arrangement a refusal should fall back to.
       *
       * Without the second the fallback is whatever last fit — which may be from a gesture several
       * drags ago, since the ref outlives every one of them. Refusing then snaps the board to an
       * arrangement the user did not just leave, which reads as the board moving on its own.
       */
      beginGesture(layout: Layout, item: string | null): void {
        moving.current = item
        if (isAdoptable(layout, DESKTOP_COLUMNS, rows)) {
          lastFitting.current = layout.map((entry) => ({ ...entry }))
        }
      },
      endGesture(): void {
        moving.current = null
      },
      /** Whether the grid would take this layout — the warning's question, asked of `resolve`. */
      accepts(layout: Layout, cols: number): boolean {
        return resolve(layout, cols, rows, moving.current).taken !== null
      },
      compact(layout: Layout, cols: number): Layout {
        // A copy, never the array handed back: the library keeps what it is given and `moveElement`
        // edits those items in place next frame, rewriting the record of what fit (ADR-009).
        const { settled, taken } = resolve(layout, cols, rows, moving.current)
        if (taken) {
          lastFitting.current = taken.map((item) => ({ ...item }))
          return taken
        }

        // Refusing means going back to the last arrangement that fit, so the gesture reverts rather
        // than half-applying. Cloned because the library treats what it gets back as its own.
        const previous = lastFitting.current
        if (previous && sameOccupants(previous, settled)) {
          return previous.map((item) => ({ ...item }))
        }
        // No previous arrangement to return to — the first render, or a widget just added. Repacking
        // is what repairs a stored layout that overlaps or overruns, which the write path rejected
        // only from this release on; clamping here leaves widgets stacked on each other permanently.
        const repacked = repack(settled, cols, rows)
        lastFitting.current = repacked.map((item) => ({ ...item }))
        return repacked
      },
    }),
    [rows],
  )
}

function sameLayout(a: LayoutItem[], b: Layout): boolean {
  if (a.length !== b.length) return false

  const byId = new Map(a.map((item) => [item.i, item]))
  return b.every((item) => {
    const current = byId.get(item.i)
    return (
      current != null &&
      current.x === item.x &&
      current.y === item.y &&
      current.w === item.w &&
      current.h === item.h
    )
  })
}

function stackedLayout(layout: LayoutItem[]): LayoutItem[] {
  const sorted = [...layout].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y
    if (a.x !== b.x) return a.x - b.x
    return a.i.localeCompare(b.i)
  })

  let nextY = 0
  return sorted.map((item) => {
    const normalized = {
      ...item,
      x: 0,
      y: nextY,
      w: 1,
    }
    nextY += Math.max(1, item.h)
    return normalized
  })
}

const DashboardGridContent = memo(function DashboardGridContent({
  widget,
  dashboardId,
  isSharedDashboard,
  canEdit,
  removeWidget,
}: {
  widget: DashboardWidget
  dashboardId: string
  isSharedDashboard: boolean
  canEdit: boolean
  removeWidget: (widgetId: string) => Promise<boolean>
}) {
  const handleRemove = useCallback(async () => {
    if (await confirm('Remove this widget from the dashboard?', { confirmLabel: 'Remove' })) {
      void removeWidget(widget.id)
    }
  }, [removeWidget, widget.id])

  return (
    <WidgetContainer
      widget={widget}
      dashboardId={dashboardId}
      isSharedDashboard={isSharedDashboard}
      canEdit={canEdit}
      onRemove={handleRemove}
    />
  )
})

export function DashboardGrid({ dashboard, canEdit }: { dashboard: Dashboard; canEdit: boolean }) {
  const saveLayout = useDashboardStore((s) => s.saveLayout)
  const removeWidget = useDashboardStore((s) => s.removeWidget)
  // Measured rather than queried in CSS: react-grid-layout takes a column count and a row height
  // as numbers, so this one cannot move into `@container`.
  const [containerRef, { width: containerWidth }, containerElement] = useContainerSize({
    width: 1200,
    height: 800,
  })
  const availableHeight = useAvailableHeight(containerElement)
  const [draftLayout, setDraftLayout] = useState<LayoutItem[]>(dashboard.layout)
  const [draftBaseVersion, setDraftBaseVersion] = useState(dashboard.version)
  const activeLayout = useMemo(
    () => (draftBaseVersion === dashboard.version ? draftLayout : dashboard.layout),
    [dashboard.layout, dashboard.version, draftBaseVersion, draftLayout],
  )
  const boundedCompactor = useBoundedCompactor(DESKTOP_ROWS)
  // Bumped on a refusal and used as the grid's key: the library re-syncs only when the `layout`
  // prop deep-differs, which a refusal leaves unchanged, so remounting is the only way (ADR-009).
  const [refusals, setRefusals] = useState(0)
  // Whether the arrangement currently under the cursor is one the grid could accept. Purely for
  // feedback: a drop that will be refused otherwise looks exactly like one that will not, right up
  // until the release snaps it back.
  const [dropBlocked, setDropBlocked] = useState(false)
  const isStacked = containerWidth < STACK_BELOW
  // A stack scrolls; it is not one screen. Bounded, the compactor refuses a stack past 24 rows and
  // returns the desktop arrangement, rendered full-width: 8968px of widgets inside a 366px phone.
  const compactor = isStacked ? verticalCompactor : boundedCompactor
  const maxRows = isStacked ? undefined : DESKTOP_ROWS
  // One canonical column count above the stacking threshold. Rendering the band below it at half is
  // a remap rather than a projection: the library clamps overflowing items and reports those
  // corrections as though they were drags, so one touch persisted the narrower grid (ADR-009).
  const cols = isStacked ? 1 : DESKTOP_COLUMNS
  const presentedLayout = useMemo(
    () =>
      isStacked
        ? stackedLayout(activeLayout)
        : // Per-item ceilings are what bound the resize *box*: react-resizable takes maxConstraints
          // in pixels, and react-grid-layout derives those from these two keys, which default to
          // Infinity. Without them a widget stretches as far as the cursor goes and only snaps back
          // on release, the size having been clamped all along.
          activeLayout.map((item) => ({
            ...item,
            maxW: Math.max(item.w, cols - item.x),
            maxH: Math.max(item.h, DESKTOP_ROWS - item.y),
          })),
    [activeLayout, cols, isStacked],
  )
  // Solved rather than picked: rows and the gaps between them have to add up to the room available,
  // so the gap is whichever is smaller — the usual 12px, or the third of a row that leaves the other
  // two thirds for the row itself.
  const verticalMargin = isStacked
    ? 8
    : Math.max(2, Math.min(MAX_MARGIN, Math.floor(availableHeight / (4 * DESKTOP_ROWS - 1))))
  const margin = (isStacked ? [8, 8] : [MAX_MARGIN, verticalMargin]) as [number, number]
  const containerPadding = [0, 0] as [number, number]
  // Floored, not rounded: a row is whole pixels and there are 24 of them, so rounding up spends
  // room this just finished measuring and puts the board back over the edge it was sized to fit.
  const rowHeight = isStacked
    ? STACK_ROW_HEIGHT
    : Math.max(
        MIN_ROW_HEIGHT,
        Math.floor((availableHeight - margin[1] * (DESKTOP_ROWS - 1)) / DESKTOP_ROWS),
      )

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      // The stack is a projection, not an arrangement, so it must never reach the canonical draft;
      // read-only views cannot edit either. Editing one would need its own persisted layout.
      if (isStacked || !canEdit) return
      if (!isAdoptable(newLayout, cols, DESKTOP_ROWS)) {
        setDropBlocked(true)
        return
      }
      setDropBlocked(false)
      setDraftBaseVersion(dashboard.version)
      setDraftLayout([...newLayout] as unknown as LayoutItem[])
    },
    [canEdit, cols, dashboard.version, isStacked],
  )

  // Cleared when a gesture starts rather than only when one ends: a refusal is the last thing that
  // happens in a drag, so the flag would otherwise still be set as the next one begins and paint the
  // first frames blocked before anything has been evaluated.
  const handleGestureStart = useCallback(
    (starting: Layout, item: Layout[number] | null) => {
      setDropBlocked(false)
      boundedCompactor.beginGesture(starting, item?.i ?? null)
    },
    [boundedCompactor],
  )

  // On the continuous event; `onLayoutChange` fires only once the gesture has ended. Asked of the
  // compactor, because what arrives is the pushed-apart layout and overlaps on almost every drag.
  const handleGestureMove = useCallback(
    (moving: Layout) => setDropBlocked(!boundedCompactor.accepts(moving, cols)),
    [boundedCompactor, cols],
  )

  // The gestured item is the widget under the cursor, and only the client can say which one that
  // was: the saved layout carries every neighbour compaction reflowed, indistinguishable server-side.
  const handleLayoutStop = useCallback(
    (newLayout: Layout, gestured: Layout[number] | null, action: LayoutGesture['action']) => {
      if (!canEdit || isStacked) return
      setDropBlocked(false)
      boundedCompactor.endGesture()
      if (!isAdoptable(newLayout, cols, DESKTOP_ROWS)) {
        setRefusals((count) => count + 1)
        return
      }
      setDraftBaseVersion(dashboard.version)
      setDraftLayout([...newLayout] as unknown as LayoutItem[])
      if (sameLayout(dashboard.layout, newLayout)) return
      // The library allows a stop with no item behind it; the layout still saves, the event just
      // keeps the sentence it has always had.
      void saveLayout(
        [...newLayout] as unknown as LayoutItem[],
        gestured ? { widget_id: gestured.i, action } : undefined,
      )
    },
    [canEdit, cols, boundedCompactor, dashboard.layout, dashboard.version, isStacked, saveLayout],
  )

  // Stable, like every other handler here: this component re-renders on each observer tick during a
  // gesture, and a fresh closure per tick would hand the grid new props throughout the drag.
  const handleDragStop = useCallback(
    (layout: Layout, gestured: Layout[number] | null) =>
      handleLayoutStop(layout, gestured, 'moved'),
    [handleLayoutStop],
  )
  const handleResizeStop = useCallback(
    (layout: Layout, gestured: Layout[number] | null) =>
      handleLayoutStop(layout, gestured, 'resized'),
    [handleLayoutStop],
  )

  if (dashboard.widgets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-zinc-600">
        <p className="text-sm">No widgets yet.</p>
        <p className="text-xs mt-1">
          {canEdit
            ? 'Use the button above to add your first widget.'
            : 'An editor can add widgets to this dashboard.'}
        </p>
      </div>
    )
  }

  return (
    // Clipped rather than bounded: a dragged widget may leave the board under the cursor, but it
    // must not add to the page's scroll height while it does, or the board shifts mid-gesture.
    <div
      ref={containerRef}
      className="w-full overflow-hidden"
      data-drop-blocked={dropBlocked || undefined}
    >
      <GridLayout
        key={refusals}
        layout={presentedLayout as unknown as Layout}
        width={containerWidth}
        // maxRows stops a gesture at the bottom edge the way cols stops one at the right —
        // `gridBounds` clamps both axes, and the vertical one was simply left at Infinity.
        gridConfig={{ cols, rowHeight, margin, containerPadding, maxRows }}
        compactor={compactor}
        // `bounded` is deliberately off: the library decides a swap by how far the dragged element
        // travelled, so clamping it disables downward reordering (ADR-009). The wrapper clips.
        dragConfig={{ enabled: canEdit && !isStacked, handle: '.drag-handle' }}
        resizeConfig={{ enabled: canEdit && !isStacked }}
        onLayoutChange={handleLayoutChange}
        onDragStart={handleGestureStart}
        onResizeStart={handleGestureStart}
        onDrag={handleGestureMove}
        onResize={handleGestureMove}
        onDragStop={handleDragStop}
        onResizeStop={handleResizeStop}
        className="w-full"
      >
        {dashboard.widgets.map((widget) => (
          // react-grid-layout needs a DOM element as the direct child so it can attach drag props.
          <div key={widget.id}>
            <DashboardGridContent
              widget={widget}
              dashboardId={dashboard.id}
              isSharedDashboard={dashboard.is_shared}
              canEdit={canEdit}
              removeWidget={removeWidget}
            />
          </div>
        ))}
      </GridLayout>
    </div>
  )
}
