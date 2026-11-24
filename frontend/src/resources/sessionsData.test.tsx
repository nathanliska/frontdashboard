// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPage } from '../api/generated/contract'
import { deferred } from '../test/fixtures'
import { revokeOtherSession, useSessions } from './sessionsData'

const { apiListSessions, apiRevokeSession } = vi.hoisted(() => ({
  apiListSessions: vi.fn(),
  apiRevokeSession: vi.fn(),
}))

vi.mock('../api/auth', () => ({ apiListSessions, apiRevokeSession }))

const CURSOR = { created_at: '2026-04-05T00:00:00Z', id: '00000000-0000-4000-8000-000000000001' }

describe('sessionsData', () => {
  beforeEach(() => {
    apiListSessions.mockReset()
    apiRevokeSession.mockReset()
  })

  it('does not read a page again when a revoke lands while it is still loading', async () => {
    const page = deferred<SessionPage>()
    apiListSessions.mockReturnValueOnce(page.promise)
    apiRevokeSession.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useSessions(CURSOR))

    await act(async () => {
      await revokeOtherSession('revoked-session')
    })
    await act(async () =>
      page.resolve({
        items: [{ id: 'revoked-session' }, { id: 'kept-session' }] as SessionPage['items'],
        next_cursor: null,
      }),
    )

    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data?.items.map((session) => session.id)).toEqual(['kept-session'])
    expect(apiListSessions).toHaveBeenCalledTimes(1)
  })

  it('does not read a page again when the revoked session was never on it', async () => {
    const held = { items: [{ id: 'kept-session' }], next_cursor: null } as SessionPage
    const refresh = deferred<SessionPage>()
    apiListSessions.mockResolvedValueOnce(held).mockReturnValueOnce(refresh.promise)
    apiListSessions.mockResolvedValue(held)
    apiRevokeSession.mockResolvedValueOnce(undefined)
    const cursor = { ...CURSOR, id: '00000000-0000-4000-8000-000000000002' }
    const { result } = renderHook(() => useSessions(cursor))
    await waitFor(() => expect(result.current.data).not.toBeNull())

    act(() => result.current.refetch())
    await act(async () => {
      await revokeOtherSession('revoked-session')
    })
    await act(async () => refresh.resolve(held))

    expect(apiListSessions).toHaveBeenCalledTimes(2)
  })
})
