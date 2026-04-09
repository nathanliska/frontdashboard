import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Dashboard } from '../../api/dashboards'
import { DashboardGrid } from './DashboardGrid'

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

describe('DashboardGrid', () => {
  it('shows viewer-friendly empty-state copy on read-only dashboards', () => {
    render(<DashboardGrid dashboard={makeDashboard()} canEdit={false} />)

    expect(screen.getByText('No widgets yet.')).toBeInTheDocument()
    expect(screen.getByText('An editor can add widgets to this dashboard.')).toBeInTheDocument()
    expect(
      screen.queryByText('Use the button above to add your first widget.'),
    ).not.toBeInTheDocument()
  })
})
