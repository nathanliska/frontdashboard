// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../api/dashboards'
import { useAuthStore } from '../stores/auth'
import { useConfirmStore } from '../stores/confirm'
import { resetDashboardData, useDashboardStore } from '../stores/dashboard'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeDashboardSummary as makeSummary } from '../test/fixtures'
import { DashboardsPage } from './DashboardsPage'

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('../stores/toast', async () =>
  (await import('../test/toast')).toastMock({ success: toastSuccess }),
)

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

    // Actions moved into the visible overflow menu. Radix opens on pointerdown.
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

describe('deleting a dashboard', () => {
  it('offers an undo that restores it, without a trip to the Trash view', async () => {
    const deleteDashboard = vi.fn().mockResolvedValue(true)
    const restoreDashboard = vi.fn().mockResolvedValue(makeSummary({ id: 'dash-1' }))
    stubDashboardStore({
      summaries: [makeSummary({ id: 'dash-1', name: 'Household' })],
      deleteDashboard,
      restoreDashboard,
    })

    render(
      <MemoryRouter>
        <DashboardsPage />
      </MemoryRouter>,
    )

    // Radix opens the menu on pointerdown, which jsdom does not synthesise from a click; the
    // keyboard path is supported and is what a keyboard user takes anyway.
    const trigger = await screen.findByRole('button', { name: 'Actions for Household' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /move to trash/i }))
    act(() => useConfirmStore.getState()._accept())

    await waitFor(() => expect(deleteDashboard).toHaveBeenCalledWith('dash-1'))

    // The action, not the wording: recovering from the toast is the point, and the message reads
    // the same with or without it.
    const action = toastSuccess.mock.calls.at(-1)?.[1] as { label: string; onAction: () => void }
    await waitFor(() => expect(action).toMatchObject({ label: 'Undo' }))

    action.onAction()
    await waitFor(() => expect(restoreDashboard).toHaveBeenCalledWith('dash-1'))
  })
})

describe('leaving a shared dashboard', () => {
  it('offers Leave instead of trash on a dashboard the user does not own', async () => {
    const leaveDashboard = vi.fn().mockResolvedValue(true)
    stubDashboardStore({
      summaries: [
        makeSummary({
          id: 'dash-2',
          name: 'Roommates',
          user_id: 'someone-else',
          access_description: 'Shared with you',
          can_manage_shares: false,
        }),
      ],
      leaveDashboard,
    })

    render(
      <MemoryRouter>
        <DashboardsPage />
      </MemoryRouter>,
    )

    const trigger = await screen.findByRole('button', { name: 'Actions for Roommates' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    // Trash would 403 for a non-owner; the way out of a shared dashboard is leaving it.
    expect(screen.queryByRole('menuitem', { name: /move to trash/i })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitem', { name: /leave dashboard/i }))

    // Leaving is not undoable from this side, so it must ask first.
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
    act(() => useConfirmStore.getState()._accept())

    await waitFor(() => expect(leaveDashboard).toHaveBeenCalledWith('dash-2'))
  })

  it('never offers Leave on a dashboard the user owns', async () => {
    stubDashboardStore({
      summaries: [makeSummary({ id: 'dash-1', name: 'Household' })],
    })

    render(
      <MemoryRouter>
        <DashboardsPage />
      </MemoryRouter>,
    )

    const trigger = await screen.findByRole('button', { name: 'Actions for Household' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(await screen.findByRole('menuitem', { name: /move to trash/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /leave dashboard/i })).not.toBeInTheDocument()
  })
})
