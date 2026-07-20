// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../../api/dashboards'
import { CreateDashboardModal } from './CreateDashboardModal'

vi.mock('../../api/users', () => ({
  apiSearchUsers: vi.fn().mockResolvedValue([]),
}))

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    id: 'dash-new',
    user_id: 'user-1',
    name: 'New Board',
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

describe('CreateDashboardModal', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not call onCreated (and does not reject) when create fails (#10)', async () => {
    const onCreated = vi.fn()
    // The store contract: createDashboard resolves null on failure, never throws.
    const createDashboard = vi.fn().mockResolvedValue(null)

    render(
      <CreateDashboardModal
        onCreated={onCreated}
        onClose={vi.fn()}
        createDashboard={createDashboard}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('My Dashboard'), {
      target: { value: 'New Board' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createDashboard).toHaveBeenCalled())
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('calls onCreated with the summary when create succeeds (#10)', async () => {
    const onCreated = vi.fn()
    const summary = makeSummary()
    const createDashboard = vi.fn().mockResolvedValue(summary)

    render(
      <CreateDashboardModal
        onCreated={onCreated}
        onClose={vi.fn()}
        createDashboard={createDashboard}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('My Dashboard'), {
      target: { value: 'New Board' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(summary))
  })
})
