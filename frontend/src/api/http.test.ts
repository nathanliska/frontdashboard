import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestVoid } from './http'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('./client', () => ({ apiFetch }))

describe('requestVoid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves on a 204 response', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 })
    await expect(requestVoid('/x', { method: 'DELETE' }, 'fail')).resolves.toBeUndefined()
  })

  it('rejects a typed ApiError on non-2xx, using the parsed detail', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ detail: 'Not allowed' }),
    })
    await expect(requestVoid('/x', { method: 'DELETE' }, 'fail')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Not allowed',
    })
    expect(ApiError).toBeDefined()
  })

  it('falls back to the provided message when there is no detail', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error('no body')),
    })
    await expect(requestVoid('/x', { method: 'DELETE' }, 'Failed to delete')).rejects.toMatchObject(
      {
        status: 500,
        message: 'Failed to delete',
      },
    )
  })
})
