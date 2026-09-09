// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPage } from '../../api/generated/contract'
import { SessionsPanel } from './SessionsPanel'

const api = vi.hoisted(() => ({ apiListSessions: vi.fn(), apiRevokeSession: vi.fn() }))
vi.mock('../../api/auth', () => api)

const page: SessionPage = {
  items: [
    {
      id: 'current',
      created_at: '2026-09-06T10:00:00Z',
      last_used_at: '2026-09-06T11:00:00Z',
      expires_at: '2026-10-06T10:00:00Z',
      is_current: true,
    },
    {
      id: 'other',
      created_at: '2026-09-05T10:00:00Z',
      last_used_at: '2026-09-06T09:00:00Z',
      expires_at: '2026-10-05T10:00:00Z',
      is_current: false,
    },
  ],
  next_cursor: null,
}

describe('session management', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    api.apiListSessions.mockResolvedValue(page)
    api.apiRevokeSession.mockResolvedValue(undefined)
  })

  it('shares the initial request and removes a revoked session without refetching', async () => {
    render(
      <StrictMode>
        <SessionsPanel />
      </StrictMode>,
    )
    expect(await screen.findByText('This session')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Revoke session/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Revoke session/ }))
    await waitFor(() => expect(screen.queryByText('Other session')).not.toBeInTheDocument())
    expect(api.apiRevokeSession).toHaveBeenCalledWith('other')
    expect(api.apiListSessions).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed revocation visible with an error and a retry', async () => {
    api.apiRevokeSession.mockRejectedValueOnce(new Error('Temporarily unavailable'))
    render(<SessionsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /^Revoke session/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable')
    expect(screen.getByText('Other session')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Revoke session/ }))
    await waitFor(() => expect(screen.queryByText('Other session')).not.toBeInTheDocument())
    expect(api.apiListSessions).toHaveBeenCalledTimes(1)
  })

  it('filters revoked rows from a later refresh snapshot', async () => {
    render(<SessionsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /^Revoke session/ }))
    await waitFor(() => expect(screen.queryByText('Other session')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))
    await act(async () => {})
    expect(api.apiListSessions).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Other session')).not.toBeInTheDocument()
  })

  it('uses the returned cursor even after revoking the last row', async () => {
    const cursor = { created_at: page.items[1].created_at, id: 'other' }
    api.apiListSessions
      .mockResolvedValueOnce({ ...page, next_cursor: cursor })
      .mockResolvedValueOnce({ items: [], next_cursor: null })
    render(<SessionsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /^Revoke session/ }))
    await waitFor(() => expect(screen.queryByText('Other session')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Older sessions' }))
    expect(await screen.findByText('No sessions on this page.')).toBeInTheDocument()
    expect(api.apiListSessions).toHaveBeenLastCalledWith(cursor)
  })
})
