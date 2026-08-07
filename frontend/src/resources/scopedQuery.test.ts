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

describe('cache eviction', () => {
  function makeCappedQuery(fetcher: (scope: Scope) => Promise<string>, maxCachedScopes: number) {
    return createScopedQuery<Scope, string>({
      getKey: (s) => s.id,
      fetcher,
      maxCachedScopes,
    })
  }

  it('drops the coldest entries once the cap is passed', async () => {
    const fetcher = vi.fn(async (scope: Scope) => `data-${scope.id}`)
    const q = makeCappedQuery(fetcher, 3)

    for (const id of ['a', 'b', 'c', 'd']) {
      await q.fetchIfStale({ id })
    }

    // 'a' was the coldest when 'd' arrived, so it is gone and re-reads refetch.
    expect(q.getState({ id: 'a' }).data).toBeNull()
    expect(q.getState({ id: 'd' }).data).toBe('data-d')
    expect(q.getState({ id: 'c' }).data).toBe('data-c')
  })

  it('counts a re-fetch as recent use, so the genuinely coldest entry goes', async () => {
    const fetcher = vi.fn(async (scope: Scope) => `data-${scope.id}`)
    const q = makeCappedQuery(fetcher, 3)

    await q.fetchIfStale({ id: 'a' })
    await q.fetchIfStale({ id: 'b' })
    await q.fetchIfStale({ id: 'c' })
    // Touch 'a' so 'b' becomes the coldest.
    await q.fetch({ id: 'a' })
    await q.fetchIfStale({ id: 'd' })

    expect(q.getState({ id: 'a' }).data).toBe('data-a')
    expect(q.getState({ id: 'b' }).data).toBeNull()
  })

  it('never evicts an entry with a request still in flight', async () => {
    let resolvePending: ((value: string) => void) | undefined
    const fetcher = vi.fn(async (scope: Scope) => {
      if (scope.id === 'slow') {
        return new Promise<string>((resolve) => {
          resolvePending = resolve
        })
      }
      return `data-${scope.id}`
    })
    const q = makeCappedQuery(fetcher, 2)

    const pending = q.fetch({ id: 'slow' })
    for (const id of ['x', 'y', 'z']) {
      await q.fetchIfStale({ id })
    }

    // The response must have an entry to land in, or it is silently discarded.
    resolvePending?.('data-slow')
    await pending
    expect(q.getState({ id: 'slow' }).data).toBe('data-slow')
  })
})
