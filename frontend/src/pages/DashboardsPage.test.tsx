// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../api/dashboards'
import { useAuthStore } from '../stores/auth'
import { resetDashboardData, useDashboardStore } from '../stores/dashboard'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeDashboardSummary as makeSummary } from '../test/fixtures'
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

describe('DashboardsPage', () => {
  beforeEach(() => {
    // Module-level load/debounce state lives outside the store, so setState alone won't clear it.
    resetDashboardData()
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

    stubDashboardStore({ summaries: [makeSummary()] })
  })

  it('derives the editing dashboard from summaries and closes the modal on access loss', async () => {
    render(
      <MemoryRouter>
        <DashboardsPage />
      </MemoryRouter>,
    )

    // Actions moved into the visible overflow menu (#27). Radix opens on pointerdown.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Primary Dashboard' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit dashboard' }))

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
