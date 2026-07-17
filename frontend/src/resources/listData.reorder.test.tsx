// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import { useAuthStore } from '../stores/auth'
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

vi.mock('../stores/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return {
    id: 'list-1',
    dashboard_id: 'dash-1',
    name: 'Groceries',
    list_type: 'todo',
    sort_order: 0,
    archived: false,
    created_by: 'user-1',
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    item_count: 3,
    ...overrides,
  }
}

function makeListItem(id: string, overrides: Partial<ListItem> = {}): ListItem {
  return {
    id,
    list_id: 'list-1',
    text: id,
    checked: false,
    sort_order: 0,
    due_date: null,
    priority: null,
    category: null,
    assigned_to: null,
    created_by: 'user-1',
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    ...overrides,
  }
}

function makeListDetail(itemIds: string[], overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    ...makeListSummary(),
    items: itemIds.map((id) => makeListItem(id)),
    ...overrides,
  }
}

function ItemsProbe({ listId }: { listId: string }) {
  const detail = useListDetail(listId)
  return (
    <p data-testid="items-order">{detail.data?.items.map((item) => item.id).join(',') ?? ''}</p>
  )
}

function ListsProbe({ dashboardId }: { dashboardId: string }) {
  const summaries = useListSummaries(dashboardId)
  return <p data-testid="lists-order">{summaries.data?.map((list) => list.id).join(',') ?? ''}</p>
}

describe('reorderListItems / list.item.reordered', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetListDataForTests()
    useAuthStore.setState({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'user@example.com',
        display_name: 'Example User',
        preferences: {},
      },
    })
  })

  it('calls apiReorderItems with the new id order and optimistically reorders the cache immediately', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    apiReorderItems.mockResolvedValueOnce(undefined)

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

    let pending!: Promise<void>
    act(() => {
      pending = reorderListItems('list-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('items-order')).toHaveTextContent('c,a,b')
    expect(apiReorderItems).toHaveBeenCalledWith('list-1', ['c', 'a', 'b'], expect.any(Object))

    await act(async () => {
      await pending
    })
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('rolls back to the previous order when the mutation is rejected', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    apiReorderItems.mockRejectedValueOnce(new Error('nope'))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

    await act(async () => {
      await reorderListItems('list-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')
  })

  it('reorders detail items from a remote actor payload without issuing a GET', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

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

    expect(screen.getByTestId('items-order')).toHaveTextContent('c,b,a')
    expect(apiGetList).not.toHaveBeenCalled()
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('does not double-apply a self-echoed reorder event over optimistic state', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    apiReorderItems.mockResolvedValueOnce(undefined)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    )

    render(<ItemsProbe listId="list-1" />)

    await act(async () => {
      await reorderListItems('list-1', ['c', 'a', 'b'])
    })
    expect(screen.getByTestId('items-order')).toHaveTextContent('c,a,b')

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

    expect(screen.getByTestId('items-order')).toHaveTextContent('c,a,b')
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('falls back to exactly one refetch when the payload id set diverges from the cache', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b', 'c', 'd']))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

    act(() => {
      handleListResourceEvent({
        event_id: 3,
        event_type: 'list.item.reordered',
        entity_type: 'list_item',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1', list_id: 'list-1', item_ids: ['x', 'y', 'z'] },
        created_at: '2026-04-05T00:00:03Z',
      })
    })

    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c,d')
  })

  it('duplicate ids in the payload are treated as divergence, not applied', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b', 'c']))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

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
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')
  })

  it('rolls back and refetches exactly once on a 409 conflict, forgetting the pending mutation', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444',
    )
    apiReorderItems.mockRejectedValueOnce(new ApiError('conflict', 409))
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b', 'c']))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

    await act(async () => {
      await reorderListItems('list-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')
    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))
    expect(hasPendingListMutation('44444444-4444-4444-8444-444444444444')).toBe(false)
  })

  it('rolls back with zero refetches on a non-409 error, forgetting the pending mutation', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b', 'c']))
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '55555555-5555-4555-8555-555555555555',
    )
    apiReorderItems.mockRejectedValueOnce(new ApiError('server error', 500))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

    await act(async () => {
      await reorderListItems('list-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')
    expect(apiGetList).not.toHaveBeenCalled()
    expect(hasPendingListMutation('55555555-5555-4555-8555-555555555555')).toBe(false)
  })

  it('does not silently drop a reorder event when the list detail has no cached data (fetch in flight)', async () => {
    let resolveFirstFetch!: (detail: ListDetail) => void
    const firstFetch = new Promise<ListDetail>((resolve) => {
      resolveFirstFetch = resolve
    })
    apiGetList.mockReturnValueOnce(firstFetch)
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b', 'c']))

    const { unmount } = render(<ItemsProbe listId="list-1" />)
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
      resolveFirstFetch(makeListDetail(['a', 'b', 'c']))
      await firstFetch
    })

    // The in-flight GET resolved with pre-event order — the silent-loss scenario: the
    // reorder event raced the fetch and lost.
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')

    unmount()
    render(<ItemsProbe listId="list-1" />)

    // The divergence must have marked the entry stale, so a later remount (standing in
    // for any future resync/remount) triggers a second GET that converges the client.
    // Against the pre-fix code this stays at 1 forever.
    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(2))
  })
})

describe('reorderLists / list.reordered', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetListDataForTests()
    useAuthStore.setState({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'user@example.com',
        display_name: 'Example User',
        preferences: {},
      },
    })
  })

  it('calls apiReorderLists with the new id order and optimistically reorders the summaries cache', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)
    apiReorderLists.mockResolvedValueOnce(undefined)

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')

    let pending!: Promise<void>
    act(() => {
      pending = reorderLists('dash-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('lists-order')).toHaveTextContent('c,a,b')
    expect(apiReorderLists).toHaveBeenCalledWith('dash-1', ['c', 'a', 'b'], expect.any(Object))

    await act(async () => {
      await pending
    })
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('optimistically reorders only the active subset when an archived list is in cache, preserving it', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'zz', archived: true }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)
    apiReorderLists.mockResolvedValueOnce(undefined)

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,zz,c')

    let pending!: Promise<void>
    act(() => {
      pending = reorderLists('dash-1', ['c', 'a', 'b'])
    })

    // Optimistic update must land immediately, reordering only the active
    // lists and preserving the archived one — not bailing out to unchanged
    // state because orderedIds.length !== rows.length.
    expect(screen.getByTestId('lists-order')).toHaveTextContent('c,a,b,zz')
    expect(apiReorderLists).toHaveBeenCalledWith('dash-1', ['c', 'a', 'b'], expect.any(Object))

    await act(async () => {
      await pending
    })
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('rolls back the summaries cache when the mutation is rejected', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)
    apiReorderLists.mockRejectedValueOnce(new Error('nope'))

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')

    await act(async () => {
      await reorderLists('dash-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')
  })

  it('reorders the non-archived subset from a remote payload, appends archived, and issues no GET', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'zz', archived: true }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,zz,c')

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.reordered',
        entity_type: 'dashboard',
        entity_id: 'dash-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1', list_ids: ['c', 'b', 'a'] },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    expect(screen.getByTestId('lists-order')).toHaveTextContent('c,b,a,zz')
    expect(apiGetLists).not.toHaveBeenCalled()
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('falls back to exactly one refetch when the list id payload diverges from the cache', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)
    apiGetLists.mockResolvedValueOnce([
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'c' }),
      makeListSummary({ id: 'd' }),
    ])

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')

    act(() => {
      handleListResourceEvent({
        event_id: 2,
        event_type: 'list.reordered',
        entity_type: 'dashboard',
        entity_id: 'dash-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1', list_ids: ['x', 'y', 'z'] },
        created_at: '2026-04-05T00:00:02Z',
      })
    })

    await waitFor(() => expect(apiGetLists).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c,d')
  })

  it('rolls back and refetches exactly once on a 409 conflict, forgetting the pending mutation', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '66666666-6666-4666-8666-666666666666',
    )
    apiReorderLists.mockRejectedValueOnce(new ApiError('conflict', 409))
    apiGetLists.mockResolvedValueOnce(summaries)

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')

    await act(async () => {
      await reorderLists('dash-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')
    await waitFor(() => expect(apiGetLists).toHaveBeenCalledTimes(1))
    expect(hasPendingListMutation('66666666-6666-4666-8666-666666666666')).toBe(false)
  })

  it('rolls back with zero refetches on a non-409 error, forgetting the pending mutation', async () => {
    const summaries = [
      makeListSummary({ id: 'a' }),
      makeListSummary({ id: 'b' }),
      makeListSummary({ id: 'c' }),
    ]
    __seedListSummariesForTests('dash-1', summaries)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '77777777-7777-4777-8777-777777777777',
    )
    apiReorderLists.mockRejectedValueOnce(new Error('nope'))

    render(<ListsProbe dashboardId="dash-1" />)
    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')

    await act(async () => {
      await reorderLists('dash-1', ['c', 'a', 'b'])
    })

    expect(screen.getByTestId('lists-order')).toHaveTextContent('a,b,c')
    expect(apiGetLists).not.toHaveBeenCalled()
    expect(hasPendingListMutation('77777777-7777-4777-8777-777777777777')).toBe(false)
  })
})
