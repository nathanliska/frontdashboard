// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import { useAuthStore } from '../stores/auth'
import {
  __resetListDataForTests,
  addListItem,
  handleListResourceEvent,
  updateListItem,
  updateListName,
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

vi.mock('../stores/toast', () => ({
  toast: {
    error: vi.fn(),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function ListProbe() {
  const summaries = useListSummaries('dash-1')
  const detail = useListDetail('list-1')

  return (
    <div>
      <p data-testid="list-loading">{summaries.loading ? 'loading' : 'idle'}</p>
      <p data-testid="list-error">{detail.error ? detail.error.message : 'none'}</p>
      {summaries.data?.map((list) => (
        <p key={list.id}>{list.name}</p>
      ))}
      {detail.data?.items.map((item) => (
        <p key={item.id}>{item.text}</p>
      ))}
    </div>
  )
}

describe('listData', () => {
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

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps selected list detail visible during a background SSE refresh', async () => {
    const refreshRequest = deferred<ListDetail>()

    apiGetLists.mockResolvedValueOnce([makeListSummary()])
    apiGetList.mockResolvedValueOnce(makeListDetail()).mockReturnValueOnce(refreshRequest.promise)

    render(<ListProbe />)

    await screen.findByText('Buy milk')
    expect(apiGetList).toHaveBeenCalledTimes(1)

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.item.updated',
        entity_type: 'list_item',
        entity_id: 'item-1',
        entity_version: 1,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { list_id: 'list-1', dashboard_id: 'dash-1' },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await waitFor(() => expect(apiGetList).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Buy milk')).toBeInTheDocument()

    await act(async () => {
      refreshRequest.resolve(
        makeListDetail({
          items: [makeListItem({ text: 'Buy bread', updated_at: '2026-04-05T00:00:01Z' })],
          updated_at: '2026-04-05T00:00:01Z',
        }),
      )
      await refreshRequest.promise
    })

    await screen.findByText('Buy bread')
  })

  it('removes deleted lists from active summaries and detail views immediately', async () => {
    apiGetLists.mockResolvedValueOnce([makeListSummary()])
    apiGetList.mockResolvedValueOnce(makeListDetail())

    render(<ListProbe />)

    await screen.findByText('Groceries')
    await screen.findByText('Buy milk')

    act(() => {
      handleListResourceEvent({
        event_id: 1,
        event_type: 'list.deleted',
        entity_type: 'list',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1' },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
      expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('list-error')).toHaveTextContent('List not found')
  })

  it('does not refetch the list detail for self-echoed local item updates', async () => {
    apiGetLists.mockResolvedValueOnce([makeListSummary()])
    apiGetList.mockResolvedValueOnce(makeListDetail())
    apiUpdateItem.mockResolvedValueOnce(makeListItem({ checked: true }))
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    )

    render(<ListProbe />)

    await screen.findByText('Buy milk')
    expect(apiGetList).toHaveBeenCalledTimes(1)

    await act(async () => {
      await updateListItem('list-1', 'item-1', { checked: true })
    })

    act(() => {
      handleListResourceEvent({
        event_id: 2,
        event_type: 'list.item.checked',
        entity_type: 'list_item',
        entity_id: 'item-1',
        entity_version: 2,
        actor_id: 'user-1',
        actor_display_name: 'Example User',
        payload: {
          list_id: 'list-1',
          dashboard_id: 'dash-1',
          client_mutation_id: '11111111-1111-4111-8111-111111111111',
        },
        created_at: '2026-04-05T00:00:02Z',
      })
    })

    await waitFor(() => expect(apiUpdateItem).toHaveBeenCalledTimes(1))
    expect(apiGetList).toHaveBeenCalledTimes(1)
  })

  it('does not refetch list summaries for self-echoed local list updates', async () => {
    apiGetLists.mockResolvedValueOnce([makeListSummary()])
    apiGetList.mockResolvedValueOnce(makeListDetail())
    apiUpdateList.mockResolvedValueOnce(makeListSummary({ name: 'Weekend groceries' }))
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    )

    render(<ListProbe />)

    await screen.findByText('Groceries')
    expect(apiGetLists).toHaveBeenCalledTimes(1)

    await act(async () => {
      await updateListName('list-1', 'Weekend groceries')
    })

    act(() => {
      handleListResourceEvent({
        event_id: 3,
        event_type: 'list.updated',
        entity_type: 'list',
        entity_id: 'list-1',
        entity_version: 2,
        actor_id: 'user-1',
        actor_display_name: 'Example User',
        payload: {
          dashboard_id: 'dash-1',
          client_mutation_id: '22222222-2222-4222-8222-222222222222',
        },
        created_at: '2026-04-05T00:00:03Z',
      })
    })

    await waitFor(() => expect(apiUpdateList).toHaveBeenCalledTimes(1))
    expect(apiGetLists).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Weekend groceries')).toBeInTheDocument()
  })

  it('rethrows add item failures so forms can keep their current value', async () => {
    apiCreateItem.mockRejectedValueOnce(new Error('nope'))

    await expect(addListItem('list-1', 'Buy eggs')).rejects.toThrow('nope')
    expect(apiCreateItem).toHaveBeenCalledTimes(1)
  })
})
