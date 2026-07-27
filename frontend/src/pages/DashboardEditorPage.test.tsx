// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDashboardData, useDashboardStore } from '../stores/dashboard'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeDashboard } from '../test/fixtures'
import { DashboardEditorPage } from './DashboardEditorPage'

vi.mock('../components/dashboard/DashboardGrid', () => ({
  DashboardGrid: () => <div>grid</div>,
}))

vi.mock('../components/dashboard/AddWidgetModal', () => ({
  AddWidgetModal: () => null,
}))

vi.mock('../components/dashboard/DashboardSettingsModal', () => ({
  DashboardSettingsModal: () => null,
}))

describe('DashboardEditorPage', () => {
  beforeEach(() => {
    document.title = 'FrontDashboard'
    // Module-level load/debounce state lives outside the store, so stubbing it won't clear it.
    resetDashboardData()
    stubDashboardStore({
      summariesLoaded: false,
      dashboard: makeDashboard({ name: 'Product Roadmap' }),
    })
  })

  it('sets the browser title to the current dashboard name and restores the app title on unmount', () => {
    const view = render(
      <MemoryRouter initialEntries={['/dashboard/dash-1']}>
        <Routes>
          <Route path="/dashboard/:id" element={<DashboardEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Product Roadmap' })).toBeInTheDocument()
    expect(document.title).toBe('Product Roadmap')

    view.unmount()

    expect(document.title).toBe('FrontDashboard')
  })

  it('hides edit controls for viewers', () => {
    useDashboardStore.setState({
      dashboard: makeDashboard({
        name: 'Read Only Board',
        is_shared: true,
        can_edit: false,
        can_manage_shares: false,
      }),
    })

    render(
      <MemoryRouter initialEntries={['/dashboard/dash-1']}>
        <Routes>
          <Route path="/dashboard/:id" element={<DashboardEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add widget/i })).not.toBeInTheDocument()
  })
})
