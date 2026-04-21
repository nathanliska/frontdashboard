import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../api/dashboards'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'
import { DashboardsPage } from './DashboardsPage'

vi.mock('../components/dashboard/DashboardSettingsModal', () => ({
  DashboardSettingsModal: ({
    dashboard,
    onClose,
  }: {
    dashboard: Pick<DashboardSummary, 'id' | 'name' | 'can_manage_shares'>
    onClose: () => void
  }) => (
    <div>
      <p>Editing {dashboard.name}</p>
      <p>Can manage shares: {String(dashboard.can_manage_shares)}</p>
      <button type="button" onClick={onClose}>
        Close modal
      </button>
    </div>
  ),
}))

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
    archived: false,
    access_description: 'Owned by you',
    is_shared: false,
    can_edit: true,
    can_manage_shares: true,
    is_favorite: false,
    version: 1,
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    ...overrides,
  }
}

describe('DashboardsPage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'test@example.com',
        display_name: 'Test User',
        preferences: {
          home_dashboard_id: null,
          favorite_dashboard_ids: [],
        },
      },
      init: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      updatePreferences: vi.fn(),
      updateProfile: vi.fn(),
      changePassword: vi.fn(),
    })

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      summariesLoading: false,
      dashboard: null,
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

  it('derives the editing dashboard from summaries and closes the modal on access loss', async () => {
    render(
      <MemoryRouter>
        <DashboardsPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTitle('Edit dashboard'))

    expect(screen.getByText('Editing Primary Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Can manage shares: true')).toBeInTheDocument()

    act(() => {
      useDashboardStore.setState({
        summaries: [makeSummary({ name: 'Renamed Dashboard', can_manage_shares: false })],
      })
    })

    expect(await screen.findByText('Editing Renamed Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Can manage shares: false')).toBeInTheDocument()

    act(() => {
      useDashboardStore.setState({
        summaries: [
          makeSummary({ name: 'Renamed Dashboard', can_edit: false, can_manage_shares: false }),
        ],
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Editing Renamed Dashboard')).not.toBeInTheDocument()
    })
  })
})
