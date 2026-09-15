// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../../api/dashboards'
import { makeDashboardSummary } from '../../test/fixtures'
import { CreateDashboardModal } from './CreateDashboardModal'

vi.mock('../../api/users', () => ({
  apiSearchUsers: vi.fn().mockResolvedValue([]),
}))

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return makeDashboardSummary({ id: 'dash-new', name: 'New Board', ...overrides })
}

describe('CreateDashboardModal', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not call onCreated (and does not reject) when create fails', async () => {
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

  it('calls onCreated with the summary when create succeeds', async () => {
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
