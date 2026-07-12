import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDeleteItem, apiDeleteList } from './lists'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('./client', () => ({ apiFetch }))

describe('list delete wrappers surface server failures', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects apiDeleteList on a 500', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({}),
    })
    await expect(apiDeleteList('list-1')).rejects.toMatchObject({ name: 'ApiError', status: 500 })
  })

  it('resolves apiDeleteList on a 204', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 })
    await expect(apiDeleteList('list-1')).resolves.toBeUndefined()
  })

  it('rejects apiDeleteItem on a 403', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ detail: 'Not allowed' }),
    })
    await expect(apiDeleteItem('list-1', 'item-1')).rejects.toMatchObject({ status: 403 })
  })
})
