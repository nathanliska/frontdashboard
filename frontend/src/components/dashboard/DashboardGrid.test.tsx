// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dashboard, DashboardWidget, LayoutItem } from '../../api/dashboards'
import { DashboardGrid } from './DashboardGrid'

const gridSpy = vi.hoisted(() => ({
  lastLayout: [] as LayoutItem[],
  lastCols: null as null | number,
  lastRowHeight: null as null | number,
  lastMaxRows: null as null | number,
  lastMarginY: null as null | number,
  lastDragBounded: null as null | boolean,
  onDrag: null as null | ((layout: LayoutItem[]) => void),
  onDragStart: null as null | ((layout: LayoutItem[], item: LayoutItem) => void),
  compact: null as null | ((layout: LayoutItem[], cols: number) => LayoutItem[]),
  onLayoutChange: null as null | ((layout: unknown) => void),
}))

const resizeSpy = vi.hoisted(() => ({
  cb: null as null | ((entries: { contentRect: { width: number } }[]) => void),
}))

vi.mock('react-grid-layout', () => {
  function MockGridLayout({
    children,
    layout,
    gridConfig,
    dragConfig,
    compactor,
    onLayoutChange,
    onDrag,
    onDragStart,
  }: {
    children: React.ReactNode
    layout: LayoutItem[]
    gridConfig?: { cols?: number; rowHeight?: number; maxRows?: number; margin?: [number, number] }
    dragConfig?: { bounded?: boolean }
    compactor?: { compact?: (layout: LayoutItem[], cols: number) => LayoutItem[] }
    onLayoutChange?: (layout: unknown) => void
    onDrag?: (layout: LayoutItem[]) => void
    onDragStart?: (layout: LayoutItem[], item: LayoutItem) => void
  }) {
    gridSpy.lastLayout = layout
    gridSpy.lastCols = gridConfig?.cols ?? null
    gridSpy.lastRowHeight = gridConfig?.rowHeight ?? null
    gridSpy.lastMaxRows = gridConfig?.maxRows ?? null
    gridSpy.lastMarginY = gridConfig?.margin?.[1] ?? null
    gridSpy.lastDragBounded = dragConfig?.bounded ?? null
    gridSpy.compact = compactor?.compact ?? null
    gridSpy.onLayoutChange = onLayoutChange ?? null
    gridSpy.onDrag = onDrag ?? null
    gridSpy.onDragStart = onDragStart ?? null

    const childTypes = React.Children.toArray(children).map((child) => {
      if (!React.isValidElement(child)) return typeof child
      return typeof child.type === 'string'
        ? child.type
        : ((child.type as { displayName?: string; name?: string }).displayName ??
            (child.type as { displayName?: string; name?: string }).name ??
            'component')
    })

    return (
      <div data-testid="grid" data-child-types={childTypes.join(',')}>
        {children}
      </div>
    )
  }

  return {
    GridLayout: MockGridLayout,
    // Real enough to drive the wrapper under test: it settles items upward the way the library
    // does, so the bounded compactor's own arithmetic is what the assertions exercise.
    verticalCompactor: {
      type: 'vertical',
      allowOverlap: false,
      compact: (layout: LayoutItem[]) => {
        const settled: LayoutItem[] = []
        for (const item of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
          let y = 0
          for (const placed of settled) {
            if (item.x < placed.x + placed.w && placed.x < item.x + item.w) {
              y = Math.max(y, placed.y + placed.h)
            }
          }
          settled.push({ ...item, y })
        }
        return settled
      },
    },
  }
})

class MockResizeObserver {
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
    resizeSpy.cb = cb
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

// jsdom reports a zero-height rect for every element, so available height resolves to the
// window height here. Enough to drive the bound; the header offset is verified in a browser.
function setViewportHeight(height: number): void {
  act(() => {
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
    window.dispatchEvent(new Event('resize'))
  })
}

function setWidth(width: number): void {
  act(() => {
    resizeSpy.cb?.([{ contentRect: { width } }])
  })
}

function makeDashboard(): Dashboard {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Shared Board',
    is_shared: true,
    can_edit: false,
    can_manage_shares: false,
    is_favorite: false,
    layout: [],
    version: 1,
    widgets: [],
  }
}

function makeClockWidget(id: string): DashboardWidget {
  return {
    id,
    dashboard_id: 'dash-1',
    widget_type: 'clock',
    widget_version: 1,
    config: {},
    resource_type: null,
    resource_id: null,
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
  }
}

const TWO_WIDGETS = [makeClockWidget('widget-1'), makeClockWidget('widget-2')]

function withWidgets(): Dashboard {
  return { ...makeDashboard(), widgets: TWO_WIDGETS, layout: CANONICAL_LAYOUT }
}

const CANONICAL_LAYOUT: LayoutItem[] = [
  { i: 'widget-1', x: 0, y: 0, w: 4, h: 3 },
  { i: 'widget-2', x: 4, y: 0, w: 4, h: 3 },
]

describe('DashboardGrid', () => {
  // Both spies outlive a test. Left set, an assertion reads the previous test's grid and passes
  // without this one having rendered one at all.
  beforeEach(() => {
    gridSpy.lastLayout = []
    gridSpy.lastCols = null
    gridSpy.lastRowHeight = null
    gridSpy.lastMaxRows = null
    gridSpy.lastMarginY = null
    gridSpy.lastDragBounded = null
    gridSpy.compact = null
    gridSpy.onLayoutChange = null
    gridSpy.onDrag = null
    gridSpy.onDragStart = null
    resizeSpy.cb = null
  })
  it('does not let the stacked projection overwrite the canonical layout', () => {
    render(
      <DashboardGrid
        dashboard={{
          ...makeDashboard(),
          can_edit: true,
          layout: CANONICAL_LAYOUT,
          widgets: TWO_WIDGETS,
        }}
        canEdit
      />,
    )

    // Narrow viewport: the library is handed the one-column projection.
    setWidth(400)
    expect(gridSpy.lastLayout.every((item) => item.x === 0 && item.w === 1)).toBe(true)

    // react-grid-layout echoes that projection back through onLayoutChange.
    act(() => gridSpy.onLayoutChange?.(gridSpy.lastLayout))

    // Back on desktop the canonical arrangement must be intact, not the projection.
    setWidth(1200)
    const byId = new Map(gridSpy.lastLayout.map((item) => [item.i, item]))
    expect(byId.get('widget-1')).toMatchObject({ x: 0, w: 4 })
    expect(byId.get('widget-2')).toMatchObject({ x: 4, w: 4 })
  })

  it('keeps one canonical column count at every editable width', () => {
    render(
      <DashboardGrid
        dashboard={{
          ...makeDashboard(),
          can_edit: true,
          layout: CANONICAL_LAYOUT,
          widgets: TWO_WIDGETS,
        }}
        canEdit
      />,
    )

    // Every width that is editable is one drags get saved against, and rendering the narrow end of
    // that range at fewer columns fed the library's clamping back as if the user had done it. One
    // count across the band, not a literal — `test_grid_basis_coverage.py` pins the number itself.
    const counts = new Set<number>()
    for (const width of [960, 1100, 1400, 1800]) {
      setWidth(width)
      counts.add(gridSpy.lastCols as number)
      const byId = new Map(gridSpy.lastLayout.map((item) => [item.i, item]))
      expect(byId.get('widget-2')).toMatchObject({ x: 4, w: 4 })
    }
    expect(counts.size).toBe(1)
    expect([...counts][0]).toBeGreaterThan(1)

    // Below the breakpoint it is a read-only one-column projection, which is a different rule.
    setWidth(400)
    expect(gridSpy.lastCols).toBe(1)
  })

  it('sizes a row from the window, not from the column', () => {
    render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)

    // The whole board is one screen, so the row is a share of the height and the width has no say.
    // Same width, two window heights: the short one must give the shorter row.
    setViewportHeight(3400)
    setWidth(3568)
    const tallWindow = gridSpy.lastRowHeight

    setViewportHeight(1300)
    const shortWindow = gridSpy.lastRowHeight

    expect(shortWindow).toBeLessThan(tallWindow as number)

    // And the width genuinely does not enter into it — a far narrower board, still wide enough to
    // be a grid rather than a stack, keeps the same row.
    setWidth(1000)
    expect(gridSpy.lastRowHeight).toBe(shortWindow)
  })

  it.each([1303, 1300, 1100, 940, 700, 524])(
    'fits the whole board in the room available at %ipx',
    (available) => {
      // Every row and every gap has to add up to no more than the room there is — that is the
      // entire promise of a bounded grid, and it has to hold at heights that divide badly, not
      // just at round ones.
      setViewportHeight(available)
      render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)
      setWidth(2278)

      const rows = gridSpy.lastMaxRows as number
      const gap = gridSpy.lastMarginY as number
      expect((gridSpy.lastRowHeight as number) * rows + gap * (rows - 1)).toBeLessThanOrEqual(
        available,
      )
    },
  )

  it('keeps the gaps from eating a small screen', () => {
    // 23 gaps against 24 rows, so a fixed 12px margin takes over half a small laptop's height and
    // leaves rows too thin to hold anything. The gap gives way before the row does.
    setViewportHeight(524)
    render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)
    setWidth(1084)

    const rows = gridSpy.lastMaxRows as number
    const gapTotal = (gridSpy.lastMarginY as number) * (rows - 1)

    expect(gapTotal).toBeLessThan(524 / 2)
    expect(gridSpy.lastRowHeight as number).toBeGreaterThan(gridSpy.lastMarginY as number)
  })

  it('bounds the layout to the same budget the row height is sized for', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)
    setWidth(2278)

    // The row budget and the row height come from one number, so a layout can never grow past the
    // window it was sized to fit. Asserting they agree, not that maxRows equals some literal —
    // that would restate the constant instead of the property it exists for.
    const budget = gridSpy.lastMaxRows as number
    const rendered = (gridSpy.lastRowHeight as number) * budget + 12 * (budget - 1)

    expect(budget).toBeGreaterThan(0)
    expect(rendered).toBeLessThanOrEqual(1300)
  })

  it('leaves the dragged widget free to travel, and clips the board instead', () => {
    setViewportHeight(1300)
    const { container } = render(
      <DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />,
    )
    setWidth(2278)

    // Clamping the dragged element disables downward reordering outright, because the library
    // decides a swap by how far that element travelled: measured, it stopped at row 12 against a
    // midpoint at row 17 and the placeholder never left row 0. The wrapper clips instead.
    expect(gridSpy.lastDragBounded).toBeNull()
    expect(container.querySelector('.overflow-hidden')).not.toBeNull()
  })

  it('rejects a settlement that would push a widget out of the grid', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    // Compaction is the one thing `maxRows` cannot reach — `Compactor.compact(layout, cols)` is
    // never handed it — so displacing a neighbour is the only way a widget leaves a bounded grid.
    // Establish a fitting arrangement first: rejection means returning to the last one that fit.
    const fitting = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 4, h: 4 },
        { i: 'widget-2', x: 0, y: 4, w: 4, h: 4 },
      ],
      24,
    )
    expect(fitting.map((item) => item.y)).toEqual([0, 4])

    // Now one that cannot settle inside 24 rows: stacked in the same column, 20 + 20.
    const rejected = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 4, h: 20 },
        { i: 'widget-2', x: 0, y: 20, w: 4, h: 20 },
      ],
      24,
    )

    expect(rejected).toEqual(fitting)
  })

  it('keeps settling normally while the result still fits', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    // The bound must not cost the ordinary case: two widgets swapping places is exactly what
    // forbidding collisions outright would have broken, so it has to keep working here.
    const swapped = compact(
      [
        { i: 'widget-1', x: 0, y: 12, w: 4, h: 11 },
        { i: 'widget-2', x: 0, y: 0, w: 4, h: 12 },
      ],
      24,
    )

    expect(swapped.find((item) => item.i === 'widget-2')?.y).toBe(0)
    expect(swapped.find((item) => item.i === 'widget-1')?.y).toBe(12)
    expect(Math.max(...swapped.map((item) => item.y + item.h))).toBeLessThanOrEqual(24)
  })

  it('gives every widget a ceiling that reaches the edge exactly, so a resize stops there', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)

    // react-resizable bounds the resize box from these two keys; left at Infinity a widget
    // stretched to wherever the cursor went and snapped back on release (528 -> 2928 -> 1176).
    // Asserting the ceiling lands on the edge, not a literal, so it survives the grid retuning.
    const bounded = gridSpy.lastLayout as (LayoutItem & { maxW?: number; maxH?: number })[]
    expect(bounded).toHaveLength(2)
    expect(Number.isFinite(gridSpy.lastMaxRows as number)).toBe(true)
    for (const item of bounded) {
      expect(item.x + (item.maxW as number)).toBe(gridSpy.lastCols)
      expect(item.y + (item.maxH as number)).toBe(gridSpy.lastMaxRows)
    }
  })

  it('repairs a stored layout that already overlaps, instead of leaving it broken', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    // The exact shape that reached the database: in bounds individually, overlapping in fact. The
    // write path has never checked overlap, so a board can arrive like this — and on first render
    // there is no earlier arrangement to fall back to, so this is the only thing that fixes it.
    const repaired = compact(
      [
        { i: 'widget-1', x: 0, y: 1, w: 3, h: 5 },
        { i: 'widget-2', x: 2, y: 0, w: 21, h: 20 },
      ],
      24,
    )

    const overlapping = repaired.some((a, i) =>
      repaired.some(
        (b, j) =>
          i !== j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h,
      ),
    )
    expect(overlapping).toBe(false)
    expect(repaired.every((item) => item.y + item.h <= 24 && item.x + item.w <= 24)).toBe(true)
    expect(repaired).toHaveLength(2)
  })

  it('marks a drop the grid cannot accept while the gesture is still running', () => {
    setViewportHeight(1300)
    const { container } = render(
      <DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />,
    )
    setWidth(2278)
    const blocked = () => container.querySelector('[data-drop-blocked]') !== null

    expect(blocked()).toBe(false)

    // Driven from the continuous event, because `onLayoutChange` only fires once the gesture ends
    // — by then a warning has nothing left to warn about, and the widget has already sprung back.
    // Blocked here for the one reason compaction cannot fix: settled, this still runs past row 24.
    act(() =>
      gridSpy.onDrag?.([
        { i: 'widget-1', x: 0, y: 1, w: 4, h: 5 },
        { i: 'widget-2', x: 2, y: 0, w: 8, h: 20 },
      ]),
    )
    expect(blocked()).toBe(true)

    act(() => gridSpy.onDrag?.(CANONICAL_LAYOUT))
    expect(blocked()).toBe(false)
  })

  it('does not call a drag blocked for the overlap every drag passes through', () => {
    setViewportHeight(1300)
    const { container } = render(
      <DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />,
    )
    setWidth(2278)
    const blocked = () => container.querySelector('[data-drop-blocked]') !== null

    // `onDrag` carries `moveElement`'s output: pushed aside, not settled. This compacts apart into
    // rows 0-3 and 3-6 without trouble, but judged unsettled it reads as blocked — which painted
    // the placeholder red through 20 of the 30 frames of a drag that went on to succeed.
    act(() =>
      gridSpy.onDrag?.([
        { i: 'widget-1', x: 0, y: 0, w: 4, h: 3 },
        { i: 'widget-2', x: 0, y: 0, w: 4, h: 3 },
      ]),
    )

    expect(blocked()).toBe(false)
  })

  it('makes room sideways for a drag compaction alone would refuse', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    // No spare cell: 20 columns beside 4, both the full 24 rows. Dragging the wide one to column 0
    // has an answer — the narrow one belongs at column 20 — but compaction only settles upward, so
    // it pushes that one to row 24 and refuses against plain evidence the arrangement fits.
    act(() =>
      gridSpy.onDragStart?.(
        [
          { i: 'widget-1', x: 4, y: 0, w: 20, h: 24 },
          { i: 'widget-2', x: 0, y: 0, w: 4, h: 24 },
        ],
        { i: 'widget-1', x: 4, y: 0, w: 20, h: 24 },
      ),
    )

    const made = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 20, h: 24 },
        { i: 'widget-2', x: 0, y: 0, w: 4, h: 24 },
      ],
      24,
    )

    expect(made.find((item) => item.i === 'widget-1')).toMatchObject({ x: 0, y: 0 })
    expect(made.find((item) => item.i === 'widget-2')).toMatchObject({ x: 20, y: 0 })
  })

  it('still refuses when the sideways room does not exist either', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    const start = [
      { i: 'widget-1', x: 4, y: 0, w: 20, h: 24 },
      { i: 'widget-2', x: 0, y: 0, w: 4, h: 24 },
    ]
    act(() => gridSpy.onDragStart?.(start, start[0] as LayoutItem))

    // Column 2 instead of 0: the same widget, one column further in, leaving a 2-wide strip on each
    // side and nowhere for a 4-wide neighbour. Re-seating has to decline rather than part-place it,
    // or a widget lands somewhere nobody asked for.
    const refused = compact(
      [
        { i: 'widget-1', x: 2, y: 0, w: 20, h: 24 },
        { i: 'widget-2', x: 0, y: 0, w: 4, h: 24 },
      ],
      24,
    )

    expect(refused).toEqual(start)
  })

  it('remembers what fit as a copy, so the gesture cannot rewrite it', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    const fitting = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 24, h: 4 },
        { i: 'widget-2', x: 0, y: 4, w: 24, h: 4 },
      ],
      24,
    )

    // The library keeps what it is handed and `moveElement` edits those items in place next frame,
    // so holding the reference lets the drag rewrite the record of what fit — measured as the whole
    // board sliding a row down mid-gesture and holding there until the drop snapped it back.
    for (const item of fitting) item.y += 20

    const refused = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 24, h: 20 },
        { i: 'widget-2', x: 0, y: 20, w: 24, h: 20 },
      ],
      24,
    )

    expect(refused.map((item) => item.y).sort((a, b) => a - b)).toEqual([0, 4])
  })

  it('falls back to the arrangement this gesture started from, not an older one', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]

    // A refusal returns the last arrangement known to fit, and that memory outlives the gesture
    // that filled it. An earlier drag leaves its own result there...
    compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 24, h: 4 },
        { i: 'widget-2', x: 0, y: 4, w: 24, h: 4 },
      ],
      24,
    )

    // ...so without pinning the board as it stands when the next one begins, refusing that drag
    // snaps every widget to where a previous drag left them, which reads as the board moving itself.
    const started = [
      { i: 'widget-1', x: 0, y: 4, w: 24, h: 4 },
      { i: 'widget-2', x: 0, y: 0, w: 24, h: 4 },
    ]
    act(() => gridSpy.onDragStart?.(started, started[0] as LayoutItem))

    // Two full-width widgets of 20 rows each: nothing fits beside anything, so there is no sideways
    // room to find and the refusal is the only answer left.
    const refused = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 24, h: 20 },
        { i: 'widget-2', x: 0, y: 20, w: 24, h: 20 },
      ],
      24,
    )

    expect(refused.map((item) => `${item.i}@${item.y}`).sort()).toEqual([
      'widget-1@4',
      'widget-2@0',
    ])
  })

  it('refuses a layout whose widgets overlap, not just one that leaves the grid', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const before = gridSpy.lastLayout.map((item) => ({ ...item }))

    // Every coordinate is in range, so a bounds check waves it through — and the two widgets sit on
    // top of each other. That is what a refused settlement looks like, and it reached the database
    // as two widgets stacked in the same cells.
    act(() =>
      gridSpy.onLayoutChange?.([
        { i: 'widget-1', x: 0, y: 1, w: 4, h: 5 },
        { i: 'widget-2', x: 2, y: 0, w: 8, h: 20 },
      ]),
    )

    expect(gridSpy.lastLayout.map((item) => ({ ...item }))).toEqual(before)
  })

  it('refuses a layout that would leave the grid, rather than adopting it', () => {
    setViewportHeight(1300)
    render(<DashboardGrid dashboard={{ ...withWidgets(), can_edit: true }} canEdit />)
    setWidth(2278)
    const before = gridSpy.lastLayout.map((item) => ({ ...item }))

    // A gesture is bounded but its consequences are not: widening a widget displaces what it lands
    // on, and the only compaction axis is vertical. The write path 422s this, so adopting it
    // locally would show an arrangement the server has already refused.
    act(() =>
      gridSpy.onLayoutChange?.([
        { i: 'widget-1', x: 0, y: 0, w: 4, h: 3 },
        { i: 'widget-2', x: 4, y: 22, w: 4, h: 6 },
      ]),
    )

    expect(gridSpy.lastLayout.map((item) => ({ ...item }))).toEqual(before)
  })

  it('holds the row bound whatever a stored layout contains', () => {
    setViewportHeight(1300)
    render(
      <DashboardGrid
        dashboard={{
          ...makeDashboard(),
          can_edit: true,
          layout: [{ i: 'widget-1', x: 0, y: 0, w: 4, h: 40 }],
          widgets: [TWO_WIDGETS[0]],
        }}
        canEdit
      />,
    )
    setWidth(2278)

    // Migration brings stored boards inside the grid, but the bound must not be conditional on
    // that having worked — a lift-when-it-overflows escape hatch is how the grid stopped being a
    // boundary at all, and it also made `maxRows - y` go negative and collapse widgets to one row.
    expect(gridSpy.lastMaxRows).toBe(24)
  })

  it('does not bound the stack to the desktop row count', () => {
    setViewportHeight(844)
    render(
      <DashboardGrid
        dashboard={{
          ...makeDashboard(),
          widgets: TWO_WIDGETS,
          // Stacked, these are 28 rows — ordinary on a phone, and past the desktop bound.
          layout: [
            { i: 'widget-1', x: 0, y: 0, w: 12, h: 14 },
            { i: 'widget-2', x: 12, y: 0, w: 12, h: 14 },
          ],
        }}
        canEdit={false}
      />,
    )
    setWidth(390)

    // A phone scrolls; it is not one screen. Bounded, the compactor refuses the projection and
    // hands back the last desktop arrangement, which then renders those desktop columns against a
    // full-width single column — measured at 8968px of widgets inside a 366px phone.
    expect(gridSpy.lastMaxRows).toBeNull()
    expect(gridSpy.lastLayout.map((item) => item.w)).toEqual([1, 1])
    expect(gridSpy.lastLayout.map((item) => item.y)).toEqual([0, 14])

    // And the compactor it is handed must settle that stack rather than refuse it.
    const compact = gridSpy.compact as (l: LayoutItem[], c: number) => LayoutItem[]
    const settled = compact(
      [
        { i: 'widget-1', x: 0, y: 0, w: 1, h: 14 },
        { i: 'widget-2', x: 0, y: 14, w: 1, h: 14 },
      ],
      1,
    )
    expect(settled.map((item) => item.y)).toEqual([0, 14])
  })

  it('leaves the stack on its own row height, where a column is the whole width', () => {
    render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)

    // At one column the column *is* the viewport, so the desktop ratio would make a single row
    // taller than the screen. A stack is excluded from that scaling, not clamped by it — so the row
    // must hold still across widths and stay far below the column it would otherwise track.
    setWidth(366)
    const narrow = gridSpy.lastRowHeight as number
    setWidth(420)

    expect(gridSpy.lastCols).toBe(1)
    expect(narrow).toBe(gridSpy.lastRowHeight)
    expect(narrow).toBeLessThan(366)
  })

  it('stacks on the width the threshold turns on, not somewhere either side of it', () => {
    render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)

    // STACK_BELOW is 960 and the comparison is `<`. Probing 400 and 1200 passes against an
    // off-by-one and against the threshold having been left anywhere in between, which is the
    // regression worth catching — the old 640 kept a 24-column grid down to a 97px widget.
    setWidth(959)
    expect(gridSpy.lastCols).toBe(1)

    setWidth(960)
    expect(gridSpy.lastCols).toBeGreaterThan(1)
  })

  it('gives a stacked row enough height for a default widget to be worth reading', () => {
    render(<DashboardGrid dashboard={withWidgets()} canEdit={false} />)
    setWidth(400)

    // A default widget is six rows tall. At the 20px row a phone wanted, that stacked to 160px —
    // a list showing one and a half of its twelve items. Asserted as the height a widget gets
    // rather than the constant, so the row unit is free to move as long as the outcome holds.
    const rowHeight = gridSpy.lastRowHeight as number
    const margin = gridSpy.lastMarginY as number
    expect(rowHeight * 6 + margin * 5).toBeGreaterThanOrEqual(250)
  })

  it('still accepts desktop layout edits, so the guard does not over-block', () => {
    render(
      <DashboardGrid
        dashboard={{
          ...makeDashboard(),
          can_edit: true,
          layout: CANONICAL_LAYOUT,
          widgets: TWO_WIDGETS,
        }}
        canEdit
      />,
    )

    setWidth(1200)
    act(() =>
      gridSpy.onLayoutChange?.([
        { i: 'widget-1', x: 2, y: 0, w: 4, h: 3 },
        { i: 'widget-2', x: 6, y: 0, w: 4, h: 3 },
      ]),
    )

    const byId = new Map(gridSpy.lastLayout.map((item) => [item.i, item]))
    expect(byId.get('widget-1')).toMatchObject({ x: 2 })
  })

  it('shows viewer-friendly empty-state copy on read-only dashboards', () => {
    render(<DashboardGrid dashboard={makeDashboard()} canEdit={false} />)

    expect(screen.getByText('No widgets yet.')).toBeInTheDocument()
    expect(screen.getByText('An editor can add widgets to this dashboard.')).toBeInTheDocument()
    expect(
      screen.queryByText('Use the button above to add your first widget.'),
    ).not.toBeInTheDocument()
  })

  it('renders widgets inside direct DOM grid items so drag props can attach', () => {
    render(
      <DashboardGrid
        dashboard={{
          ...makeDashboard(),
          can_edit: true,
          layout: [{ i: 'widget-1', x: 0, y: 0, w: 4, h: 3 }],
          widgets: [
            {
              id: 'widget-1',
              dashboard_id: 'dash-1',
              widget_type: 'clock',
              widget_version: 1,
              config: {},
              resource_type: null,
              resource_id: null,
              created_at: '2026-04-13T00:00:00Z',
              updated_at: '2026-04-13T00:00:00Z',
            },
          ],
        }}
        canEdit
      />,
    )

    expect(screen.getByTestId('grid')).toHaveAttribute('data-child-types', 'div')
    expect(screen.getByText('Clock')).toBeInTheDocument()
  })
})
