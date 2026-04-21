import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dashboard } from '../../api/dashboards'
import { DashboardGrid } from './DashboardGrid'

vi.mock('react-grid-layout', () => {
  function MockGridLayout({ children }: { children: React.ReactNode }) {
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
    default: MockGridLayout,
    WidthProvider: <T,>(component: T) => component,
  }
})

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver

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

describe('DashboardGrid', () => {
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
