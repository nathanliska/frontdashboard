import { describe, expect, it, vi } from 'vitest'

const { requestVoid } = vi.hoisted(() => ({ requestVoid: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./http', () => ({ requestVoid }))
vi.mock('./client', () => ({ apiFetch: vi.fn() }))

import { apiReorderItems, apiReorderLists } from './lists'

describe('reorder api', () => {
  it('PUTs item order with the client mutation header', async () => {
    await apiReorderItems('list-1', ['b', 'a'], { clientMutationId: 'm1' })
    expect(requestVoid).toHaveBeenCalledWith(
      '/api/lists/list-1/items/order',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'X-Client-Mutation-Id': 'm1' },
        body: JSON.stringify({ item_ids: ['b', 'a'] }),
      }),
      expect.any(String),
    )
  })

  it('PUTs list order with dashboard id', async () => {
    await apiReorderLists('dash-1', ['y', 'x'])
    expect(requestVoid).toHaveBeenCalledWith(
      '/api/lists/order',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ dashboard_id: 'dash-1', list_ids: ['y', 'x'] }),
      }),
      expect.any(String),
    )
  })
})
