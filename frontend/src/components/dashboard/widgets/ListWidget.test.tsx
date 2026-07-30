// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/http'
import type { ListDetail, ListItem } from '../../../api/lists'
import { __resetListDataForTests, handleListResourceEvent } from '../../../resources/listData'
import { resetDashboardData, useDashboardStore } from '../../../stores/dashboard'
import {
  makeListDetail as baseListDetail,
  makeListItem as baseListItem,
} from '../../../test/fixtures'
import { ListWidget } from './ListWidget'

const apiMocks = vi.hoisted(() => ({
  apiCreateItem: vi.fn(),
  apiGetList: vi.fn(),
  apiUpdateItem: vi.fn(),
}))

vi.mock('../../../api/lists', () => ({
  ...apiMocks,
}))

// "Groceries" and "Buy milk" are asserted against in the rendered widget, so they belong to this
// file; the shared fixtures supply everything else.
const AT = '2026-04-05T00:00:00Z'

function makeListDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return baseListDetail({
    name: 'Groceries',
    list_type: 'todo',
    created_at: AT,
    updated_at: AT,
    items: [makeListItem()],
    ...overrides,
  })
}

function makeListItem(overrides: Partial<ListItem> = {}): ListItem {
  return baseListItem({ text: 'Buy milk', created_at: AT, updated_at: AT, ...overrides })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ListWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetListDataForTests()
    // Module-level load/debounce state lives outside the store, so setState alone won't clear it.
    resetDashboardData()
    useDashboardStore.setState({
      summaries: [],
      summariesLoaded: false,
      summariesLoading: false,
      dashboard: null,
      loading: false,
      loadError: false,
      conflict: false,
    })

    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps current list items visible during a background SSE revalidation', async () => {
    const initialDetail = makeListDetail()
    const refreshedDetail = makeListDetail({
      items: [makeListItem({ text: 'Buy bread', updated_at: '2026-04-05T00:00:01Z' })],
      updated_at: '2026-04-05T00:00:01Z',
    })
    const refreshRequest = deferred<ListDetail>()

    apiMocks.apiGetList
      .mockResolvedValueOnce(initialDetail)
      .mockReturnValueOnce(refreshRequest.promise)

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByText('Buy milk')
    expect(apiMocks.apiGetList).toHaveBeenCalledTimes(1)

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.item.updated',
        entity_type: 'list_item',
        entity_id: 'item-1',
        entity_version: 1,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: {
          list_id: 'list-1',
          dashboard_id: 'dash-1',
        },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await waitFor(() => expect(apiMocks.apiGetList).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Buy milk')).toBeInTheDocument()

    await act(async () => {
      refreshRequest.resolve(refreshedDetail)
      await refreshRequest.promise
    })

    await screen.findByText('Buy bread')
  })

  it('shows all items instead of collapsing the list into a hidden-count summary', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        item_count: 7,
        items: Array.from({ length: 7 }, (_, index) =>
          makeListItem({
            id: `item-${index + 1}`,
            text: `Item ${index + 1}`,
            sort_order: index,
          }),
        ),
      }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByText('Item 7')
    expect(screen.queryByText('+1 more')).not.toBeInTheDocument()
  })

  it('offers a retry for outages, and the retry recovers', async () => {
    // A network failure is not access loss: the copy must not claim deletion, and the state
    // must offer a way out.
    apiMocks.apiGetList
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeListDetail())

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByText("Couldn't load this list")
    expect(screen.queryByText('List unavailable')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await screen.findByText('Buy milk')
    expect(apiMocks.apiGetList).toHaveBeenCalledTimes(2)
  })

  it('shows the unavailable state after a forced revalidation loses access', async () => {
    // Access loss is an ApiError 404 at the boundary — a plain Error would be an outage,
    // which now renders the retryable state instead.
    apiMocks.apiGetList
      .mockResolvedValueOnce(makeListDetail())
      .mockRejectedValueOnce(new ApiError('Not found', 404))

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByText('Buy milk')

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.item.updated',
        entity_type: 'list_item',
        entity_id: 'item-1',
        entity_version: 1,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: {
          list_id: 'list-1',
          dashboard_id: 'dash-1',
        },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await screen.findByText('List unavailable')
  })
})
