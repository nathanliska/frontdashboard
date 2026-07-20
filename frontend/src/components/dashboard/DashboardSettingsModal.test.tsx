// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../../api/dashboards'
import type { ResourceShare } from '../../api/shares'
import { __resetPendingDashboardMutationsForTests } from '../../utils/dashboard/dashboardMutation'
import { DashboardSettingsModal } from './DashboardSettingsModal'

const {
  apiAddDashboardShare,
  apiGetDashboard,
  apiGetDashboardShares,
  apiRemoveDashboardShare,
  apiUpdateDashboardShare,
} = vi.hoisted(() => ({
  apiAddDashboardShare: vi.fn(),
  apiGetDashboard: vi.fn(),
  apiGetDashboardShares: vi.fn(),
  apiRemoveDashboardShare: vi.fn(),
  apiUpdateDashboardShare: vi.fn(),
}))

const { apiSearchUsers } = vi.hoisted(() => ({
  apiSearchUsers: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())

vi.mock('../../api/dashboards', () => ({
  apiAddDashboardShare,
  apiGetDashboard,
  apiGetDashboardShares,
  apiRemoveDashboardShare,
  apiUpdateDashboardShare,
}))

vi.mock('../../api/users', () => ({
  apiSearchUsers,
}))

vi.mock('../../stores/toast', () => ({
  toast: {
    error: toastError,
  },
}))

function makeShare(overrides: Partial<ResourceShare> = {}): ResourceShare {
  return {
    id: 'share-1',
    resource_type: 'dashboard',
    resource_id: 'dash-1',
    principal_type: 'user',
    principal_id: 'user-2',
    principal_name: 'Viewer One',
    role: 'viewer',
    granted_by: 'user-1',
    created_at: '2026-04-08T00:00:00Z',
    ...overrides,
  }
}

function makeSummary(
  overrides: Partial<DashboardSummary> = {},
): Pick<DashboardSummary, 'id' | 'name' | 'can_manage_shares'> {
  return {
    id: 'dash-1',
    name: 'Primary Dashboard',
    archived: false,
    can_manage_shares: true,
    ...overrides,
  }
}

describe('DashboardSettingsModal', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    __resetPendingDashboardMutationsForTests()
  })

  it('passes client mutation ids for share updates, removals, and additions', async () => {
    apiGetDashboardShares.mockResolvedValue([makeShare()])
    apiUpdateDashboardShare.mockResolvedValue(makeShare({ role: 'editor' }))
    apiRemoveDashboardShare.mockResolvedValue(undefined)
    apiSearchUsers.mockResolvedValue([
      { id: 'user-3', display_name: 'Teammate', email: 'teammate@example.com' },
    ])
    apiAddDashboardShare.mockResolvedValue(
      makeShare({
        id: 'share-2',
        principal_id: 'user-3',
        principal_name: 'Teammate',
      }),
    )

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={vi.fn()} onRename={vi.fn()} />,
    )

    await screen.findByText('Viewer One')

    const shareRoleSelect = screen.getAllByDisplayValue('View')[1]
    fireEvent.change(shareRoleSelect, { target: { value: 'editor' } })

    await waitFor(() => {
      expect(apiUpdateDashboardShare).toHaveBeenCalledWith(
        'dash-1',
        'share-1',
        { role: 'editor' },
        expect.objectContaining({ clientMutationId: expect.any(String) }),
      )
    })

    fireEvent.click(screen.getByLabelText('Remove Viewer One'))

    await waitFor(() => {
      expect(apiRemoveDashboardShare).toHaveBeenCalledWith(
        'dash-1',
        'share-1',
        expect.objectContaining({ clientMutationId: expect.any(String) }),
      )
    })

    vi.useFakeTimers()
    fireEvent.change(screen.getByPlaceholderText('Search people'), {
      target: { value: 'Teammate' },
    })

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByText('Teammate')).toBeInTheDocument()
    vi.useRealTimers()

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(apiAddDashboardShare).toHaveBeenCalledWith(
        'dash-1',
        {
          principal_type: 'user',
          principal_id: 'user-3',
          role: 'viewer',
        },
        expect.objectContaining({ clientMutationId: expect.any(String) }),
      )
    })
  })

  it('keeps the modal open and the typed name when a rename fails (#10)', async () => {
    apiGetDashboardShares.mockResolvedValue([])
    const onClose = vi.fn()
    const onRename = vi.fn().mockResolvedValue(false)

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={onClose} onRename={onRename} />,
    )
    await screen.findByText('Only you can access this dashboard right now.')

    const input = screen.getByPlaceholderText('Dashboard name')
    fireEvent.change(input, { target: { value: 'Renamed Board' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('dash-1', 'Renamed Board'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Dashboard name')).toHaveValue('Renamed Board')
  })

  it('closes the modal when a rename succeeds (#10)', async () => {
    apiGetDashboardShares.mockResolvedValue([])
    const onClose = vi.fn()
    const onRename = vi.fn().mockResolvedValue(true)

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={onClose} onRename={onRename} />,
    )
    await screen.findByText('Only you can access this dashboard right now.')

    fireEvent.change(screen.getByPlaceholderText('Dashboard name'), {
      target: { value: 'Renamed Board' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps the search query when adding a share fails (#10)', async () => {
    apiGetDashboardShares.mockResolvedValue([])
    apiSearchUsers.mockResolvedValue([
      { id: 'user-3', display_name: 'Teammate', email: 'teammate@example.com' },
    ])
    apiAddDashboardShare.mockRejectedValue(new Error('boom'))

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={vi.fn()} onRename={vi.fn()} />,
    )
    await screen.findByText('Only you can access this dashboard right now.')

    vi.useFakeTimers()
    fireEvent.change(screen.getByPlaceholderText('Search people'), {
      target: { value: 'Teammate' },
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(screen.getByText('Teammate')).toBeInTheDocument()
    vi.useRealTimers()

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(apiAddDashboardShare).toHaveBeenCalled())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to add permission.'))
    // The failed add must not clear the search.
    expect(screen.getByPlaceholderText('Search people')).toHaveValue('Teammate')
  })

  it('loads dashboard shares without fetching the full dashboard', async () => {
    apiGetDashboardShares.mockResolvedValue([])

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={vi.fn()} onRename={vi.fn()} />,
    )

    await screen.findByText('Only you can access this dashboard right now.')

    expect(apiGetDashboardShares).toHaveBeenCalledWith('dash-1')
    expect(apiGetDashboard).not.toHaveBeenCalled()
  })
})
