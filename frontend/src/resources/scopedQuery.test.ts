import { describe, expect, it, vi } from 'vitest'
import { createScopedQuery } from './scopedQuery'

type Scope = { id: string }

function makeQuery(fetcher: (scope: Scope) => Promise<string>) {
  return createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })
}

describe('updateWhere and stale', () => {
  it('does not clear staleness recorded by an invalidate whose fetch was skipped', async () => {
    const fetcher = vi.fn().mockResolvedValue('server-1')
    const q = makeQuery(fetcher)

    // Seed the cache (one fetch).
    await q.fetchIfStale({ id: 'a' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    // A missed event: no listeners are mounted, so invalidateWhere marks the entry
    // stale but skips the fetch (activeOnly defaults to true).
    q.invalidateWhere((s) => s.id === 'a')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // A patch arrives for the same scope. It must NOT erase the record that we
    // still owe the server a refetch.
    q.updateWhere(
      (s) => s.id === 'a',
      (state) => ({ ...state, data: 'patched' }),
    )
    expect(q.getState({ id: 'a' }).data).toBe('patched')

    // The outstanding invalidate must still cause a refetch.
    fetcher.mockResolvedValue('server-2')
    await q.fetchIfStale({ id: 'a' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(q.getState({ id: 'a' }).data).toBe('server-2')
  })

  it('a patch alone does not trigger a refetch', async () => {
    const fetcher = vi.fn().mockResolvedValue('server-1')
    const q = makeQuery(fetcher)

    await q.fetchIfStale({ id: 'b' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    q.updateWhere(
      (s) => s.id === 'b',
      (state) => ({ ...state, data: 'patched' }),
    )

    // Nothing marked it stale, so this resolves from cache — no second GET.
    await q.fetchIfStale({ id: 'b' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(q.getState({ id: 'b' }).data).toBe('patched')
  })
})
