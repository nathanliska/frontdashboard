import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { useListsStore } from './lists'

const {
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
  apiUpdateItem,
  apiUpdateList,
} = vi.hoisted(() => ({
  apiCreateItem: vi.fn(),
  apiCreateList: vi.fn(),
  apiDeleteItem: vi.fn(),
  apiDeleteList: vi.fn(),
  apiGetList: vi.fn(),
  apiGetLists: vi.fn(),
  apiUpdateItem: vi.fn(),
  apiUpdateList: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())

vi.mock('../api/lists', () => ({
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
  apiUpdateItem,
  apiUpdateList,
}))

vi.mock('./toast', () => ({
  toast: {
    error: toastError,
  },
}))

function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return {
    id: 'list-1',
    dashboard_id: 'dash-1',
    name: 'Groceries',
    list_type: 'todo',
    archived: false,
    created_by: 'user-1',
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    item_count: 1,
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

function makeListDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    ...makeListSummary(),
    items: [makeListItem()],
    ...overrides,
  }
}

function makeSseEvent(overrides: Partial<SseEvent> = {}): SseEvent {
  return {
    event_id: 1,
    event_type: 'list.item.updated',
    group_id: null,
    entity_type: 'list_item',
    entity_id: 'item-1',
    entity_version: 1,
    actor_id: 'other-user',
    actor_display_name: 'Other User',
    payload: { list_id: 'list-1' },
    created_at: '2026-04-05T00:00:00Z',
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

describe('useListsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useListsStore.setState({
      lists: [],
      selectedId: null,
      detail: null,
      loading: false,
      dashboardId: null,
    })
  })

  it('keeps selected list detail visible during background SSE refresh', async () => {
    const initialDetail = makeListDetail()
    const refreshedDetail = makeListDetail({
      items: [makeListItem({ text: 'Buy bread', updated_at: '2026-04-05T00:00:01Z' })],
      updated_at: '2026-04-05T00:00:01Z',
    })
    const request = deferred<ListDetail>()

    apiGetList.mockReturnValue(request.promise)

    useListsStore.setState({
      lists: [makeListSummary()],
      selectedId: 'list-1',
      detail: initialDetail,
      loading: false,
      dashboardId: 'dash-1',
    })

    const refreshPromise = useListsStore.getState().handleSseEvent(makeSseEvent())

    expect(useListsStore.getState().detail?.items[0].text).toBe('Buy milk')
    expect(useListsStore.getState().loading).toBe(false)

    request.resolve(refreshedDetail)
    await refreshPromise

    expect(apiGetLists).not.toHaveBeenCalled()
    expect(useListsStore.getState().detail?.items[0].text).toBe('Buy bread')
  })
})
