// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createScopedQuery } from './scopedQuery'

type Scope = { id: string }

/** The eviction invariant that only shows up with a real subscriber (#24).
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

    // Asserted through getState rather than the rendered output: eviction does not notify
    // listeners, so React would happily keep displaying a stale snapshot of an entry that had
    // already been dropped — the component can't see the bug this is guarding against. getState
    // rebuilds a missing entry as empty, so a null here means it was evicted.
    expect(query.getState({ id: 'pinned' }).data).toBe('data-pinned')
    expect(screen.getByTestId('value')).toHaveTextContent('data-pinned')
  })
})

/** Invalidation must not re-walk the cache it is reordering (#24 regression).
 *
 * `fetch` calls `touch`, which deletes and re-inserts an entry to move it to the back of the LRU
 * order — and a Map iterator visits entries inserted during iteration. While `invalidateWhere`
 * walked the live map it therefore met the entry it had just re-inserted on the very next step,
 * refetched it, touched it again, and never terminated: one promise and closure allocated per
 * pass until the heap gave out. Because that loop is *synchronous*, no `testTimeout` could
 * interrupt it — the suite OOMed instead of failing.
 *
 * The predicate is the guard, because it is the only part of the loop a test controls and it runs
 * exactly once per iteration step. A runaway walk fails loudly here instead of hanging CI.
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
