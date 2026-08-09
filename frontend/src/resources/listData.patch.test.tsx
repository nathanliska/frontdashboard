// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import { useAuthStore } from '../stores/auth'
import { makeListItem as baseListItem, makeListSummary as baseListSummary } from '../test/fixtures'
import { CLIENT_INSTANCE_ID } from '../utils/shared/clientInstance'
import {
  __resetListDataForTests,
  __seedListDetailForTests,
  handleListResourceEvent,
  updateListItem,
  useListDetail,
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

const AT = '2026-04-05T00:00:00Z'

function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return baseListSummary({
    name: 'Groceries',
    list_type: 'todo',
    item_count: 3,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  })
}

// Items here are identified by their text, which is also their id — the patch cases are about
// which item moved, not what it says.
function makeListItem(id: string, overrides: Partial<ListItem> = {}): ListItem {
  return baseListItem({ id, text: id, created_at: AT, updated_at: AT, ...overrides })
}

function makeListDetail(itemIds: string[], overrides: Partial<ListDetail> = {}): ListDetail {
  return { ...makeListSummary(), items: itemIds.map((id) => makeListItem(id)), ...overrides }
}

function ItemsProbe({ listId }: { listId: string }) {
  const detail = useListDetail(listId)
  const items = detail.data?.items ?? []
  return (
    <div>
      <p data-testid="items-order">{items.map((item) => item.id).join(',')}</p>
      {items.map((item) => (
        <p key={item.id} data-testid={`item-${item.id}`}>
          {`${item.checked}|${item.text}`}
        </p>
      ))}
    </div>
  )
}

describe('list.item.checked / list.item.updated patching', () => {
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

  it('flips checked in cache from a remote actor event, no GET', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b']))
    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('item-a')).toHaveTextContent('false|a')

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.item.checked',
        entity_type: 'list_item',
        entity_id: 'a',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { list_id: 'list-1', dashboard_id: 'dash-1', values: { checked: true } },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    expect(screen.getByTestId('item-a')).toHaveTextContent('true|a')
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b')
    expect(apiGetList).not.toHaveBeenCalled()
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('updates text in cache from a remote actor event, no GET', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b']))
    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('item-b')).toHaveTextContent('false|b')

    act(() => {
      handleListResourceEvent({
        event_id: 2,
        event_type: 'list.item.updated',
        entity_type: 'list_item',
        entity_id: 'b',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { list_id: 'list-1', dashboard_id: 'dash-1', values: { text: 'renamed' } },
        created_at: '2026-04-05T00:00:02Z',
      })
    })

    expect(screen.getByTestId('item-b')).toHaveTextContent('false|renamed')
    expect(apiGetList).not.toHaveBeenCalled()
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('ignores identity fields smuggled in an event payload, only patching allowlisted ones', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b']))
    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b')

    act(() => {
      handleListResourceEvent({
        event_id: 6,
        event_type: 'list.item.checked',
        entity_type: 'list_item',
        entity_id: 'a',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: {
          list_id: 'list-1',
          dashboard_id: 'dash-1',
          values: { checked: true, id: 'evil', list_id: 'evil' },
        },
        created_at: '2026-04-05T00:00:06Z',
      })
    })

    // checked is patched, but the smuggled id/list_id must not rewrite item identity —
    // otherwise React keys break and this item's later events go down the divergence path.
    expect(screen.getByTestId('item-a')).toHaveTextContent('true|a')
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b')
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('falls back to exactly one refetch when the entity_id is not in the cached detail', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b']))
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b', 'c']))

    render(<ItemsProbe listId="list-1" />)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b')

    act(() => {
      handleListResourceEvent({
        event_id: 3,
        event_type: 'list.item.checked',
        entity_type: 'list_item',
        entity_id: 'missing-item',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { list_id: 'list-1', dashboard_id: 'dash-1', values: { checked: true } },
        created_at: '2026-04-05T00:00:03Z',
      })
    })

    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))
    expect(apiGetList).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('items-order')).toHaveTextContent('a,b,c')
  })

  it('falls back to invalidate-and-refetch when the event carries no values (back-compat)', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b']))
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b'], { name: 'Refetched' }))

    render(<ItemsProbe listId="list-1" />)

    act(() => {
      handleListResourceEvent({
        event_id: 4,
        event_type: 'list.item.updated',
        entity_type: 'list_item',
        entity_id: 'a',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { list_id: 'list-1', dashboard_id: 'dash-1' },
        created_at: '2026-04-05T00:00:04Z',
      })
    })

    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))
    expect(apiGetList).toHaveBeenCalledTimes(1)
  })

  it('does not double-apply a self-echoed checked event over optimistic state', async () => {
    __seedListDetailForTests('list-1', makeListDetail(['a', 'b']))
    apiUpdateItem.mockResolvedValueOnce(makeListItem('a', { checked: true }))

    render(<ItemsProbe listId="list-1" />)

    await act(async () => {
      await updateListItem('list-1', 'a', { checked: true })
    })
    expect(screen.getByTestId('item-a')).toHaveTextContent('true|a')

    act(() => {
      handleListResourceEvent({
        event_id: 5,
        event_type: 'list.item.checked',
        entity_type: 'list_item',
        entity_id: 'a',
        entity_version: 2,
        actor_id: 'user-1',
        actor_display_name: 'Example User',
        payload: {
          list_id: 'list-1',
          dashboard_id: 'dash-1',
          values: { checked: false },
          origin_client_id: CLIENT_INSTANCE_ID,
        },
        created_at: '2026-04-05T00:00:05Z',
      })
    })

    // The echo carries a stale/different value (checked: false) than the optimistic
    // state (checked: true). If echo suppression didn't fire first, this branch would
    // patch the item back to false. Suppression must win, leaving optimistic state intact.
    expect(screen.getByTestId('item-a')).toHaveTextContent('true|a')
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('does not silently drop an item-update event when the list detail has no cached data (fetch in flight)', async () => {
    let resolveFirstFetch!: (detail: ListDetail) => void
    const firstFetch = new Promise<ListDetail>((resolve) => {
      resolveFirstFetch = resolve
    })
    apiGetList.mockReturnValueOnce(firstFetch)
    apiGetList.mockResolvedValueOnce(makeListDetail(['a', 'b']))

    const { unmount } = render(<ItemsProbe listId="list-1" />)
    // The mount effect fetches because the cache has no data yet — this is the
    // "widget just mounted, GET in flight" state from the finding.
    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(1))

    act(() => {
      handleListResourceEvent({
        event_id: 10,
        event_type: 'list.item.checked',
        entity_type: 'list_item',
        entity_id: 'a',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { list_id: 'list-1', dashboard_id: 'dash-1', values: { checked: true } },
        created_at: '2026-04-05T00:00:10Z',
      })
    })

    // An invalidate must not start a duplicate request while one is already in flight.
    expect(apiGetList).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch(makeListDetail(['a', 'b']))
      await firstFetch
    })

    // The in-flight GET resolved with pre-event data (item "a" still unchecked) — this
    // is the silent-loss scenario: the event raced the fetch and lost.
    expect(screen.getByTestId('item-a')).toHaveTextContent('false|a')

    unmount()
    render(<ItemsProbe listId="list-1" />)

    // The divergence must have marked the entry stale, so a later remount (standing in
    // for any future resync/remount) triggers a second GET that converges the client.
    // Against the pre-fix code this stays at 1 forever — the event is neither applied
    // nor recorded, so nothing ever marks the entry stale.
    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(2))
  })
})
