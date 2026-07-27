// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http'
import type { ListDetail } from '../api/lists'
import { useAuthStore } from '../stores/auth'
import { makeListDetail, makeListSummary } from '../test/fixtures'
import { hasPendingListMutation } from '../utils/lists/listMutation'
import {
  __resetListDataForTests,
  __seedListDetailForTests,
  __seedListSummariesForTests,
  handleListResourceEvent,
  reorderListItems,
  reorderLists,
  useListDetail,
  useListSummaries,
} from './listData'

const {
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
  apiUpdateItem,
  apiUpdateList,
  apiReorderItems,
  apiReorderLists,
} = vi.hoisted(() => ({
  apiCreateItem: vi.fn(),
  apiCreateList: vi.fn(),
  apiDeleteItem: vi.fn(),
  apiDeleteList: vi.fn(),
  apiGetList: vi.fn(),
  apiGetLists: vi.fn(),
  apiUpdateItem: vi.fn(),
  apiUpdateList: vi.fn(),
  apiReorderItems: vi.fn(),
  apiReorderLists: vi.fn(),
}))

vi.mock('../api/lists', () => ({
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
  apiUpdateItem,
  apiUpdateList,
  apiReorderItems,
  apiReorderLists,
}))

vi.mock('../stores/toast', async () => (await import('../test/toast')).toastMock())

function ItemsProbe() {
  const detail = useListDetail('list-1')
  return <p data-testid="order">{detail.data?.items.map((item) => item.id).join(',') ?? ''}</p>
}

function ListsProbe() {
  const summaries = useListSummaries('dash-1')
  return <p data-testid="order">{summaries.data?.map((list) => list.id).join(',') ?? ''}</p>
}

function summaries(ids: string[]) {
  return ids.map((id) => makeListSummary({ id }))
}

function authenticate() {
  useAuthStore.setState({
    status: 'authenticated',
    user: {
      id: 'user-1',
      email: 'user@example.com',
      display_name: 'Example User',
      preferences: {},
    },
  })
}

/**
 * Items and lists run the same optimistic-reorder protocol over different caches: apply
 * immediately, call the API, roll back on failure, refetch once on a 409 or when a remote payload
 * disagrees with what we hold. These cases are mirrored, so they are stated once and run against
 * both. Behavior that exists on only one side — self-echo suppression and the in-flight-fetch race
 * for items — stays as its own test below, because that is
 * where the two genuinely differ.
 */
const REORDER_KINDS = [
  {
    name: 'list items',
    scope: 'list-1',
    seed: (ids: string[]) => __seedListDetailForTests('list-1', makeListDetail({ itemIds: ids })),
    Probe: ItemsProbe,
    reorder: (ids: string[]) => reorderListItems('list-1', ids),
    reorderApi: apiReorderItems,
    refetchApi: apiGetList,
    resolveRefetchWith: (ids: string[]) => makeListDetail({ itemIds: ids }),
    divergentEvent: {
      event_id: 3,
      event_type: 'list.item.reordered' as const,
      entity_type: 'list_item' as const,
      entity_id: 'list-1',
      entity_version: 2,
      actor_id: 'other-user',
      actor_display_name: 'Other User',
      payload: { dashboard_id: 'dash-1', list_id: 'list-1', item_ids: ['x', 'y', 'z'] },
      created_at: '2026-04-05T00:00:03Z',
    },
  },
  {
    name: 'lists',
    scope: 'dash-1',
    seed: (ids: string[]) => __seedListSummariesForTests('dash-1', summaries(ids)),
    Probe: ListsProbe,
    reorder: (ids: string[]) => reorderLists('dash-1', ids),
    reorderApi: apiReorderLists,
    refetchApi: apiGetLists,
    resolveRefetchWith: (ids: string[]) => summaries(ids),
    divergentEvent: {
      event_id: 2,
      event_type: 'list.reordered' as const,
      entity_type: 'dashboard' as const,
      entity_id: 'dash-1',
      entity_version: 2,
      actor_id: 'other-user',
      actor_display_name: 'Other User',
      payload: { dashboard_id: 'dash-1', list_ids: ['x', 'y', 'z'] },
      created_at: '2026-04-05T00:00:02Z',
    },
  },
]

describe.each(REORDER_KINDS)(
  'reordering $name',
  ({ scope, seed, Probe, reorder, reorderApi, refetchApi, resolveRefetchWith, divergentEvent }) => {
    beforeEach(() => {
      vi.clearAllMocks()
      __resetListDataForTests()
      authenticate()
    })

    it('applies the new order optimistically and issues no refetch on success', async () => {
      seed(['a', 'b', 'c'])
      reorderApi.mockResolvedValueOnce(undefined)

      render(<Probe />)
      expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')

      let pending!: Promise<void>
      act(() => {
        pending = reorder(['c', 'a', 'b'])
      })

      // The cache must move before the request settles — that is the whole point of optimistic.
      expect(screen.getByTestId('order')).toHaveTextContent('c,a,b')
      expect(reorderApi).toHaveBeenCalledWith(scope, ['c', 'a', 'b'], expect.any(Object))

      await act(async () => {
        await pending
      })
      expect(refetchApi).not.toHaveBeenCalled()
    })

    it('rolls back to the previous order when the mutation is rejected', async () => {
      seed(['a', 'b', 'c'])
      reorderApi.mockRejectedValueOnce(new Error('nope'))

      render(<Probe />)

      await act(async () => {
        await reorder(['c', 'a', 'b'])
      })

      expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')
    })

    it('falls back to exactly one refetch when a remote payload diverges from the cache', async () => {
      seed(['a', 'b', 'c'])
      refetchApi.mockResolvedValueOnce(resolveRefetchWith(['a', 'b', 'c', 'd']))

      render(<Probe />)
      expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')

      act(() => {
        handleListResourceEvent(divergentEvent)
      })

      await waitFor(() => expect(refetchApi).toHaveBeenCalledTimes(1))
      expect(screen.getByTestId('order')).toHaveTextContent('a,b,c,d')
    })

    it('rolls back and refetches exactly once on a 409, forgetting the pending mutation', async () => {
      const mutationId = '44444444-4444-4444-8444-444444444444'
      seed(['a', 'b', 'c'])
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(mutationId)
      reorderApi.mockRejectedValueOnce(new ApiError('conflict', 409))
      refetchApi.mockResolvedValueOnce(resolveRefetchWith(['a', 'b', 'c']))

      render(<Probe />)

      await act(async () => {
        await reorder(['c', 'a', 'b'])
      })

      expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')
      await waitFor(() => expect(refetchApi).toHaveBeenCalledTimes(1))
      expect(hasPendingListMutation(mutationId)).toBe(false)
    })

    it('rolls back with zero refetches on a non-409 error, forgetting the pending mutation', async () => {
      const mutationId = '55555555-5555-4555-8555-555555555555'
      seed(['a', 'b', 'c'])
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(mutationId)
      reorderApi.mockRejectedValueOnce(new ApiError('server error', 500))

      render(<Probe />)

      await act(async () => {
        await reorder(['c', 'a', 'b'])
      })

      expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')
      expect(refetchApi).not.toHaveBeenCalled()
      expect(hasPendingListMutation(mutationId)).toBe(false)
    })
  },
)

describe('reorderListItems / list.item.reordered — item-specific behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetListDataForTests()
    authenticate()
  })

  it('reorders detail items from a remote actor payload without issuing a GET', async () => {
    __seedListDetailForTests('list-1', makeListDetail({ itemIds: ['a', 'b', 'c'] }))

    render(<ItemsProbe />)

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.item.reordered',
        entity_type: 'list_item',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1', list_id: 'list-1', item_ids: ['c', 'b', 'a'] },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    expect(screen.getByTestId('order')).toHaveTextContent('c,b,a')
    expect(apiGetList).not.toHaveBeenCalled()
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('does not double-apply a self-echoed reorder event over optimistic state', async () => {
    __seedListDetailForTests('list-1', makeListDetail({ itemIds: ['a', 'b', 'c'] }))
    apiReorderItems.mockResolvedValueOnce(undefined)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    )

    render(<ItemsProbe />)

    await act(async () => {
      await reorderListItems('list-1', ['c', 'a', 'b'])
    })
    expect(screen.getByTestId('order')).toHaveTextContent('c,a,b')

    act(() => {
      handleListResourceEvent({
        event_id: 2,
        event_type: 'list.item.reordered',
        entity_type: 'list_item',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'user-1',
        actor_display_name: 'Example User',
        payload: {
          dashboard_id: 'dash-1',
          list_id: 'list-1',
          item_ids: ['a', 'b', 'c'],
          client_mutation_id: '33333333-3333-4333-8333-333333333333',
        },
        created_at: '2026-04-05T00:00:02Z',
      })
    })

    // Our own echo carries the pre-mutation order; applying it would undo the optimistic write.
    expect(screen.getByTestId('order')).toHaveTextContent('c,a,b')
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('treats duplicate ids in the payload as divergence rather than applying them', async () => {
    __seedListDetailForTests('list-1', makeListDetail({ itemIds: ['a', 'b', 'c'] }))
    apiGetList.mockResolvedValueOnce(makeListDetail({ itemIds: ['a', 'b', 'c'] }))

    render(<ItemsProbe />)

    act(() => {
      handleListResourceEvent({
        event_id: 4,
        event_type: 'list.item.reordered',
        entity_type: 'list_item',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1', list_id: 'list-1', item_ids: ['a', 'a', 'b'] },
        created_at: '2026-04-05T00:00:04Z',
      })
    })

    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')
  })

  it('does not silently drop a reorder event when the detail has no cached data (fetch in flight)', async () => {
    let resolveFirstFetch!: (detail: ListDetail) => void
    const firstFetch = new Promise<ListDetail>((resolve) => {
      resolveFirstFetch = resolve
    })
    apiGetList.mockReturnValueOnce(firstFetch)
    apiGetList.mockResolvedValueOnce(makeListDetail({ itemIds: ['a', 'b', 'c'] }))

    const { unmount } = render(<ItemsProbe />)
    // The mount effect fetches because the cache has no data yet — the widget-just-mounted,
    // GET-in-flight state from the finding.
    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))

    act(() => {
      handleListResourceEvent({
        event_id: 20,
        event_type: 'list.item.reordered',
        entity_type: 'list_item',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1', list_id: 'list-1', item_ids: ['c', 'b', 'a'] },
        created_at: '2026-04-05T00:00:20Z',
      })
    })

    // An invalidate must not start a duplicate request while one is already in flight.
    expect(apiGetList).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch(makeListDetail({ itemIds: ['a', 'b', 'c'] }))
      await firstFetch
    })

    // The in-flight GET resolved with pre-event order — the silent-loss scenario: the
    // reorder event raced the fetch and lost.
    expect(screen.getByTestId('order')).toHaveTextContent('a,b,c')

    unmount()
    render(<ItemsProbe />)

    // The divergence must have marked the entry stale, so a later remount (standing in
    // for any future resync/remount) triggers a second GET that converges the client.
    // Against the pre-fix code this stays at 1 forever.
    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(2))
  })
})
