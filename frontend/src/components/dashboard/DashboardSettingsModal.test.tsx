// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../../api/dashboards'
import type { ResourceShare } from '../../api/shares'
import { DashboardSettingsModal } from './DashboardSettingsModal'

const { apiGetDashboard, apiGetDashboardShares, apiRemoveDashboardShare, apiUpdateDashboardShare } =
  vi.hoisted(() => ({
    apiGetDashboard: vi.fn(),
    apiGetDashboardShares: vi.fn(),
    apiRemoveDashboardShare: vi.fn(),
    apiUpdateDashboardShare: vi.fn(),
  }))

const { apiCreateInvite, apiGetInvites, apiRevokeInvite } = vi.hoisted(() => ({
  apiCreateInvite: vi.fn(),
  apiGetInvites: vi.fn(),
  apiRevokeInvite: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())

vi.mock('../../api/dashboards', () => ({
  apiGetDashboard,
  apiGetDashboardShares,
  apiRemoveDashboardShare,
  apiUpdateDashboardShare,
}))

vi.mock('../../api/invites', () => ({
  apiCreateInvite,
  apiGetInvites,
  apiRevokeInvite,
}))

vi.mock('../../stores/toast', async () =>
  (await import('../../test/toast')).toastMock({ error: toastError }),
)

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
    can_manage_shares: true,
    ...overrides,
  }
}

describe('DashboardSettingsModal', () => {
  beforeEach(() => {
    // The share panel lists invite links on mount; every test renders it.
    apiGetInvites.mockResolvedValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('passes client mutation ids for share updates and removals', async () => {
    apiGetDashboardShares.mockResolvedValue([makeShare()])
    apiUpdateDashboardShare.mockResolvedValue(makeShare({ role: 'editor' }))
    apiRemoveDashboardShare.mockResolvedValue(undefined)

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={vi.fn()} onRename={vi.fn()} />,
    )

    await screen.findByText('Viewer One')

    const shareRoleSelect = screen.getAllByDisplayValue('View')[1]
    fireEvent.change(shareRoleSelect, { target: { value: 'editor' } })

    await waitFor(() => {
      expect(apiUpdateDashboardShare).toHaveBeenCalledWith('dash-1', 'share-1', { role: 'editor' })
    })

    fireEvent.click(screen.getByLabelText('Remove Viewer One'))

    await waitFor(() => {
      expect(apiRemoveDashboardShare).toHaveBeenCalledWith('dash-1', 'share-1')
    })
  })

  it('keeps the modal open and the typed name when a rename fails', async () => {
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

  it('closes the modal when a rename succeeds', async () => {
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

  it('shows a freshly minted invite link once and never refetches it', async () => {
    apiGetDashboardShares.mockResolvedValue([])
    apiGetInvites.mockResolvedValue([])
    apiCreateInvite.mockResolvedValue({
      id: 'invite-1',
      role: 'viewer',
      expires_at: '2026-08-01T00:00:00Z',
      created_at: '2026-07-25T00:00:00Z',
      code: 'secret-code',
    })

    render(
      <DashboardSettingsModal dashboard={makeSummary()} onClose={vi.fn()} onRename={vi.fn()} />,
    )
    await screen.findByText('Only you can access this dashboard right now.')

    fireEvent.click(screen.getByRole('button', { name: /create invite link/i }))

    // The server only stores the hash, so the code has to stay on screen until dismissed.
    const link = await screen.findByLabelText<HTMLInputElement>('Invite link')
    expect(link.value).toContain('/invite/secret-code')
    expect(apiCreateInvite).toHaveBeenCalledWith('dash-1', 'viewer')
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
