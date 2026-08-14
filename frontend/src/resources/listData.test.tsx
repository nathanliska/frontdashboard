// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import { useAuthStore } from '../stores/auth'
import { makeListItem as baseListItem, makeListSummary as baseListSummary } from '../test/fixtures'
import { CLIENT_INSTANCE_ID } from '../utils/shared/clientInstance'
import {
  __resetListDataForTests,
  addListItem,
  handleListResourceEvent,
  updateListItem,
  updateListName,
  useListDetail,
  useListSummaries,
} from './listData'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

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

vi.mock('../stores/toast', async () =>
  (await import('../test/toast')).toastMock({ error: toastError }),
)

// These names are not incidental — assertions below read "Groceries" and "Buy milk" back out of
// the rendered output, so they belong to the tests. Only the surrounding field completeness comes
// from the shared fixtures, which is what keeps a new required field a one-file change.
const AT = '2026-04-05T00:00:00Z'

function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return baseListSummary({
    name: 'Groceries',
    list_type: 'todo',
    created_at: AT,
    updated_at: AT,
    ...overrides,
  })
}

function makeListItem(overrides: Partial<ListItem> = {}): ListItem {
  return baseListItem({ text: 'Buy milk', created_at: AT, updated_at: AT, ...overrides })
}

function makeListDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return { ...makeListSummary(), items: [makeListItem()], ...overrides }
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
          origin_client_id: CLIENT_INSTANCE_ID,
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
          origin_client_id: CLIENT_INSTANCE_ID,
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

  it('tells the user what the server said, not a generic failure', async () => {
    // A quota refusal names the limit and how to free it; "Failed to add item" is unactionable.
    toastError.mockClear()
    apiCreateItem.mockRejectedValueOnce(new Error('You have reached the limit of 3 list items.'))

    await expect(addListItem('list-1', 'Buy eggs')).rejects.toThrow()
    expect(toastError).toHaveBeenCalledWith('You have reached the limit of 3 list items.')
  })
})
