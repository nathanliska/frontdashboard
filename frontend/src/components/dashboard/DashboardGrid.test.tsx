// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dashboard, DashboardWidget, LayoutItem } from '../../api/dashboards'
import { DashboardGrid } from './DashboardGrid'

const gridSpy = vi.hoisted(() => ({
  lastLayout: [] as LayoutItem[],
  lastCols: null as null | number,
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
    onLayoutChange,
  }: {
    children: React.ReactNode
    layout: LayoutItem[]
    gridConfig?: { cols?: number }
    onLayoutChange?: (layout: unknown) => void
  }) {
    gridSpy.lastLayout = layout
    gridSpy.lastCols = gridConfig?.cols ?? null
    gridSpy.onLayoutChange = onLayoutChange ?? null

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
    archived: false,
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

const CANONICAL_LAYOUT: LayoutItem[] = [
  { i: 'widget-1', x: 0, y: 0, w: 4, h: 3 },
  { i: 'widget-2', x: 4, y: 0, w: 4, h: 3 },
]

describe('DashboardGrid', () => {
  it('does not let the mobile projection overwrite the canonical layout (#9)', () => {
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

  it('keeps the canonical 12-column grid across the tablet band (#53)', () => {
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

    // 640-959px is editable, so whatever grid it renders in is a grid drags get saved against.
    // Rendering it at 6 columns made react-grid-layout clamp every item with x + w > 6 and feed
    // those corrections back as if the user had made them.
    for (const width of [640, 800, 959, 1200]) {
      setWidth(width)
      expect(gridSpy.lastCols).toBe(12)
      const byId = new Map(gridSpy.lastLayout.map((item) => [item.i, item]))
      expect(byId.get('widget-2')).toMatchObject({ x: 4, w: 4 })
    }

    // Below the breakpoint it is a read-only one-column projection, which is a different rule.
    setWidth(400)
    expect(gridSpy.lastCols).toBe(1)
  })

  it('still accepts desktop layout edits, so the guard does not over-block (#9)', () => {
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
