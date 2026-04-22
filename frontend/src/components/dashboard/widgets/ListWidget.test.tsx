// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem } from '../../../api/lists'
import { __resetListDataForTests, handleListResourceEvent } from '../../../resources/listData'
import { useDashboardStore } from '../../../stores/dashboard'
import { ListWidget } from './ListWidget'

const apiMocks = vi.hoisted(() => ({
  apiCreateItem: vi.fn(),
  apiGetList: vi.fn(),
  apiUpdateItem: vi.fn(),
}))

vi.mock('../../../api/lists', () => ({
  ...apiMocks,
}))

function makeListDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    id: 'list-1',
    dashboard_id: 'dash-1',
    name: 'Groceries',
    list_type: 'todo',
    archived: false,
    created_by: 'user-1',
    item_count: 1,
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    items: [makeListItem()],
    ...overrides,
  }
}

function makeListItem(overrides: Partial<ListItem> = {}): ListItem {
  return {
    id: 'item-1',
    list_id: 'list-1',
    text: 'Buy milk',
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

  it('shows the unavailable state after a forced revalidation loses access', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(makeListDetail()).mockRejectedValueOnce(new Error())

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
