import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useDashboardStore } from '../stores/dashboard'
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
    useDashboardStore.setState({
      summaries: [],
      summariesLoaded: false,
      summariesLoading: false,
      dashboard: {
        id: 'dash-1',
        user_id: 'user-1',
        name: 'Product Roadmap',
        archived: false,
        is_shared: false,
        can_edit: true,
        can_manage_shares: true,
        is_favorite: false,
        layout: [],
        version: 1,
        widgets: [],
      },
      loading: false,
      loadError: false,
      conflict: false,
      loadSummaries: vi.fn(),
      createDashboard: vi.fn(),
      archiveDashboard: vi.fn(),
      deleteDashboard: vi.fn(),
      toggleFavorite: vi.fn(),
      renameDashboard: vi.fn(),
      loadDashboard: vi.fn(),
      saveLayout: vi.fn(),
      addWidget: vi.fn(),
      removeWidget: vi.fn(),
      updateWidget: vi.fn(),
      handleDashboardEvent: vi.fn(),
      handleContentEvent: vi.fn(),
      resolveConflict: vi.fn(),
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
      dashboard: {
        id: 'dash-1',
        user_id: 'user-1',
        name: 'Read Only Board',
        archived: false,
        is_shared: true,
        can_edit: false,
        can_manage_shares: false,
        is_favorite: false,
        layout: [],
        version: 1,
        widgets: [],
      },
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
