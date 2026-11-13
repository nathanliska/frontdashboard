// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createScopedQuery } from './scopedQuery'

type Scope = { id: string }

/** The eviction invariant that only shows up with a real subscriber.
 *
 * A mounted component reads its entry through `useSyncExternalStore`. Evicting that entry would
 * make the next snapshot build a fresh empty one — the component would blank out and refetch, and
 * `getSnapshot` returning a new object each call risks an infinite render loop. So listeners pin.
 */
describe('scopedQuery eviction with a mounted subscriber', () => {
  it('keeps a subscribed scope even while colder scopes are pushed past the cap', async () => {
    const fetcher = vi.fn(async (scope: Scope) => `data-${scope.id}`)
    const query = createScopedQuery<Scope, string>({
      getKey: (s) => s.id,
      fetcher,
      maxCachedScopes: 2,
    })

    function Probe() {
      const { data } = query.useQuery({ id: 'pinned' })
      return <span data-testid="value">{data ?? 'empty'}</span>
    }

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('data-pinned'))

    await act(async () => {
      for (const id of ['x', 'y', 'z']) {
        await query.fetch({ id })
      }
    })

    // Asserted through getState, not the DOM: eviction does not notify listeners, so React would
    // keep showing a dropped entry. getState rebuilds a missing entry as empty, so null means
    // evicted.
    expect(query.getState({ id: 'pinned' }).data).toBe('data-pinned')
    expect(screen.getByTestId('value')).toHaveTextContent('data-pinned')
  })
})

/** Invalidation must not re-walk the cache it is reordering.
 *
 * `touch` re-inserts an entry to move it to the back of the LRU order, and a Map iterator visits
 * entries inserted during iteration — so walking the live map loops forever, synchronously, which
 * no `testTimeout` can interrupt. The predicate is the guard: it runs once per step, so a runaway
 * walk fails loudly here instead of OOMing CI.
 */
describe('scopedQuery invalidation with a mounted subscriber', () => {
  it('refetches a subscribed scope once per invalidation, not once per iteration step', async () => {
    const fetcher = vi.fn(async (scope: Scope) => `data-${scope.id}`)
    const query = createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })

    function Probe() {
      const { data } = query.useQuery({ id: 'a' })
      return <span data-testid="value">{data ?? 'empty'}</span>
    }

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('data-a'))
    expect(fetcher).toHaveBeenCalledTimes(1)

    let predicateCalls = 0
    await act(async () => {
      query.invalidateWhere((scope) => {
        predicateCalls += 1
        if (predicateCalls > 20) {
          throw new Error(
            `invalidateWhere re-walked the cache: the predicate ran ${predicateCalls} times for a single cached scope`,
          )
        }
        return scope.id === 'a'
      })
    })

    // One cached scope means exactly one predicate call, and exactly one refetch on top of the
    // fetch the mount already did.
    expect(predicateCalls).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

/** A change landing while a read is in flight must not be lost to that read's older answer. */
describe('scopedQuery changes during an in-flight read', () => {
  function setup() {
    const pending: Array<(value: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>((resolve) => pending.push(resolve)))
    const query = createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })
    const scope = { id: 'a' }
    function Probe() {
      const { data } = query.useQuery(scope)
      return <span data-testid="value">{data ?? 'empty'}</span>
    }
    const settle = (value: string) => act(async () => pending.shift()?.(value))
    return { fetcher, query, scope, Probe, settle }
  }

  it('keeps a patch over the older response and reads again', async () => {
    const { fetcher, query, scope, Probe, settle } = setup()
    render(<Probe />)
    await settle('v1')
    act(() => query.invalidateWhere(() => true))
    expect(fetcher).toHaveBeenCalledTimes(2)

    act(() =>
      query.updateWhere(
        () => true,
        (state) => ({ ...state, data: 'patched' }),
      ),
    )
    await settle('v1-again')

    expect(query.getState(scope).data).toBe('patched')
    expect(fetcher).toHaveBeenCalledTimes(3)
    await settle('v2')
    expect(query.getState(scope).data).toBe('v2')
  })

  it('reads again when invalidated mid-flight', async () => {
    const { fetcher, query, scope, Probe, settle } = setup()
    render(<Probe />)
    expect(fetcher).toHaveBeenCalledTimes(1)

    act(() => query.invalidateWhere(() => true))
    expect(fetcher).toHaveBeenCalledTimes(1)
    await settle('before-the-event')

    expect(fetcher).toHaveBeenCalledTimes(2)
    await settle('after-the-event')
    expect(query.getState(scope).data).toBe('after-the-event')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps a seed over the older response without reading again', async () => {
    const { fetcher, query, scope, Probe, settle } = setup()
    render(<Probe />)
    act(() => query.seed(scope, 'seeded'))
    await settle('older')

    expect(query.getState(scope).data).toBe('seeded')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not show the failure of a read a seed overtook', async () => {
    let fail: (reason: Error) => void = () => {}
    const fetcher = vi.fn(() => new Promise<string>((_, reject) => (fail = reject)))
    const query = createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })
    const scope = { id: 'a' }

    const read = query.fetch(scope)
    query.seed(scope, 'seeded')
    fail(new Error('boom'))

    await expect(read).resolves.toBe('seeded')
    expect(query.getState(scope)).toEqual({ data: 'seeded', loading: false, error: null })
  })

  it('reads again after a patch even with no one watching', async () => {
    const { fetcher, query, scope, settle } = setup()
    void query.fetch(scope)
    await settle('v1')
    void query.fetch(scope)
    query.updateWhere(
      () => true,
      (state) => ({ ...state, data: 'patched' }),
    )
    await settle('older')

    expect(query.getState(scope).data).toBe('patched')
    expect(fetcher).toHaveBeenCalledTimes(3)
    await settle('v2')
    expect(query.getState(scope).data).toBe('v2')
  })

  it('does not call a patched entry stale, so a second patch in the same flight still lands', async () => {
    const { fetcher, query, scope, settle } = setup()
    void query.fetch(scope)
    await settle('v1')
    void query.fetch(scope)
    query.updateWhere(
      () => true,
      (state) => ({ ...state, data: 'first' }),
    )

    expect(query.isStale(scope)).toBe(false)
    expect(query.patchOrInvalidate(scope, (held) => `${held}+second`)).toBe(true)
    await settle('older')

    expect(query.getState(scope).data).toBe('first+second')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('owes no read once a seed has replaced the patch', async () => {
    const { fetcher, query, scope, settle } = setup()
    void query.fetch(scope)
    query.updateWhere(
      () => true,
      (state) => ({ ...state, data: 'patched' }),
    )
    query.seed(scope, 'seeded')
    await settle('older')

    expect(query.getState(scope).data).toBe('seeded')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not bring back what a patch removed', async () => {
    const { query, scope, settle } = setup()
    const gone = new Error('List not found')
    void query.fetch(scope)
    query.updateWhere(
      () => true,
      () => ({ data: null, loading: false, error: gone }),
    )
    await settle('the deleted row')

    expect(query.getState(scope).data).toBeNull()
    expect(query.getState(scope).error).toBe(gone)
  })

  it('keeps a first load loading while it reads again past a patch', async () => {
    const { fetcher, query, scope, settle } = setup()
    void query.fetch(scope)
    query.updateWhere(
      () => true,
      (state) => ({ ...state, data: 'only-the-new-row' }),
    )
    await settle('older-full-list')

    expect(query.getState(scope)).toMatchObject({ data: 'only-the-new-row', loading: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await settle('full-list')
    expect(query.getState(scope)).toEqual({ data: 'full-list', loading: false, error: null })
  })

  it('stops after a failed read rather than retrying it', async () => {
    let fail: (reason: Error) => void = () => {}
    const fetcher = vi.fn(() => new Promise<string>((_, reject) => (fail = reject)))
    const query = createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })
    const scope = { id: 'a' }

    const read = query.fetch(scope)
    query.updateWhere(
      () => true,
      (state) => ({ ...state, data: 'patched' }),
    )
    fail(new Error('boom'))

    await expect(read).rejects.toThrow('boom')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(query.isStale(scope)).toBe(true)
  })

  it('can read again after a fetcher that threw before returning a promise', async () => {
    let healthy = false
    const fetcher = vi.fn((): Promise<string> => {
      if (!healthy) throw new Error('sync')
      return Promise.resolve('v1')
    })
    const query = createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })
    const scope = { id: 'a' }

    await expect(query.fetch(scope)).rejects.toThrow('sync')
    healthy = true

    await expect(query.fetch(scope)).resolves.toBe('v1')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not count a patch that changed nothing', async () => {
    const { fetcher, query, scope, settle } = setup()
    void query.fetch(scope)
    query.updateWhere(
      () => true,
      (state) => state,
    )
    await settle('v1')

    expect(query.getState(scope).data).toBe('v1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
