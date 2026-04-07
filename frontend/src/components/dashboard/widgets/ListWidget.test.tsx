import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem } from '../../../api/lists'
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
    useDashboardStore.setState({
      summaries: [],
      summariesLoaded: false,
      summariesLoading: false,
      dashboard: null,
      listContentVersion: 0,
      calendarContentVersion: 0,
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

  it('skips only the immediate self-refresh after a local toggle', async () => {
    const initialDetail = makeListDetail()
    const refreshedDetail = makeListDetail({
      items: [makeListItem({ checked: true, updated_at: '2026-04-05T00:00:01Z' })],
      updated_at: '2026-04-05T00:00:01Z',
    })
    const toggleRequest = deferred<ListItem>()

    apiMocks.apiGetList.mockResolvedValueOnce(initialDetail).mockResolvedValueOnce(refreshedDetail)
    apiMocks.apiUpdateItem.mockReturnValue(toggleRequest.promise)

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByText('Buy milk')
    expect(apiMocks.apiGetList).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Buy milk').closest('button')!)

    await waitFor(() =>
      expect(apiMocks.apiUpdateItem).toHaveBeenCalledWith('list-1', 'item-1', { checked: true }),
    )

    act(() => {
      useDashboardStore.setState({ listContentVersion: 1 })
    })

    await waitFor(() => expect(apiMocks.apiGetList).toHaveBeenCalledTimes(1))

    await act(async () => {
      toggleRequest.resolve(makeListItem({ checked: true, updated_at: '2026-04-05T00:00:01Z' }))
      await toggleRequest.promise
    })

    act(() => {
      useDashboardStore.setState({ listContentVersion: 2 })
    })

    await waitFor(() => expect(apiMocks.apiGetList).toHaveBeenCalledTimes(2))
  })
})
