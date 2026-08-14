import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCreateItem, apiDeleteItem, apiDeleteList } from './lists'

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

describe('a refused create carries both the reason and the status', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws an ApiError, not a bare Error, so callers can branch on 422', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: vi
        .fn()
        .mockResolvedValue({ detail: 'You have reached the limit of 25,000 list items.' }),
    })

    // The status is the point: these paths used to throw a bare Error carrying only the message,
    // so a caller wanting to render a quota refusal differently from a permission one could not.
    await expect(apiCreateItem('list-1', 'milk')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'You have reached the limit of 25,000 list items.',
    })
  })
})
