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
import { setPileEnabled } from '../../lists/checkedPile'
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
    window.localStorage.clear()
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

    await screen.findByPlaceholderText('Add item…')
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

  it('hides checked rows behind a collapsed Checked (N) peek by default', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [
          makeListItem({
            id: 'item-1',
            text: 'Bought thing',
            sort_order: 0,
            checked: true,
          }),
          makeListItem({ id: 'item-2', text: 'Needed thing', sort_order: 1 }),
        ],
      }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    // The tile shows only unchecked items; the pile is one peekable line.
    await screen.findByText('Needed thing')
    expect(screen.queryByText('Bought thing')).not.toBeInTheDocument()
    const peek = screen.getByRole('button', { name: 'Checked (1)' })
    expect(peek).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(peek)
    const rows = screen.getAllByRole('button').map((button) => button.textContent)
    expect(rows.indexOf('Needed thing')).toBeLessThan(rows.indexOf('Bought thing'))

    // The preference is subscribed, not read-once: flipping it from another surface
    // (the detail page's toggle) must reorder an already-mounted widget.
    act(() => setPileEnabled('list-1', false))
    expect(screen.queryByRole('button', { name: 'Checked (1)' })).not.toBeInTheDocument()
    const inPlace = screen.getAllByRole('button').map((button) => button.textContent)
    expect(inPlace.indexOf('Bought thing')).toBeLessThan(inPlace.indexOf('Needed thing'))
  })

  it('says so when everything is checked instead of showing an empty body', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [makeListItem({ id: 'item-1', text: 'Bought thing', sort_order: 0, checked: true })],
      }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    // Otherwise a full progress bar sits over blank space and the tile reads as broken.
    await screen.findByText('All done.')
    expect(screen.getByRole('button', { name: 'Checked (1)' })).toBeInTheDocument()
  })

  it('toggles the shared preference from the progress row', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [
          makeListItem({
            id: 'item-1',
            text: 'Bought thing',
            sort_order: 0,
            checked: true,
          }),
          makeListItem({ id: 'item-2', text: 'Needed thing', sort_order: 1 }),
        ],
      }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByText('Needed thing')
    const toggle = screen.getByRole('button', { name: 'Sink checked items into a pile' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(window.localStorage.getItem('listPile:list-1')).toBe('0')
    expect(screen.getByText('Bought thing')).toBeInTheDocument()
  })

  it('unchecks an existing checked item instead of duplicating it from the add form', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [
          makeListItem({
            id: 'item-1',
            text: 'Buy milk',
            checked: true,
          }),
        ],
      }),
    )
    apiMocks.apiUpdateItem.mockResolvedValueOnce(
      makeListItem({ id: 'item-1', text: 'Buy milk', checked: false }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByPlaceholderText('Add item…')
    fireEvent.change(screen.getByPlaceholderText('Add item…'), {
      target: { value: 'buy milk' },
    })
    fireEvent.submit(screen.getByPlaceholderText('Add item…').closest('form') as HTMLFormElement)

    await waitFor(() =>
      expect(apiMocks.apiUpdateItem).toHaveBeenCalledWith('list-1', 'item-1', { checked: false }),
    )
    expect(apiMocks.apiCreateItem).not.toHaveBeenCalled()
  })

  it('keeps the typed text when the dedupe uncheck fails', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [
          makeListItem({
            id: 'item-1',
            text: 'Buy milk',
            checked: true,
          }),
        ],
      }),
    )
    apiMocks.apiUpdateItem.mockRejectedValueOnce(new Error('offline'))

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByPlaceholderText('Add item…')
    const input = screen.getByPlaceholderText('Add item…')
    fireEvent.change(input, { target: { value: 'buy milk' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => expect(apiMocks.apiUpdateItem).toHaveBeenCalled())
    // The reset is success-gated: a failed uncheck must not eat the word the user typed.
    expect(input).toHaveValue('buy milk')
  })

  it('offers a checked item as a suggestion on a partial match', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [makeListItem({ id: 'item-1', text: 'Orange Juice', checked: true })],
      }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByPlaceholderText('Add item…')
    fireEvent.change(screen.getByPlaceholderText('Add item…'), { target: { value: 'Ora' } })

    // A partial, not an exact match: the exact-match toggle would fire without any suggestion
    // rendering at all, so only a prefix proves the popup itself reached the widget.
    const option = await screen.findByRole('option')
    expect(option).toHaveTextContent('Orange Juice')
    expect(option).toHaveTextContent('re-add')
  })

  it('unchecks the item when its suggestion is chosen', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [makeListItem({ id: 'item-1', text: 'Orange Juice', checked: true })],
      }),
    )
    apiMocks.apiUpdateItem.mockResolvedValueOnce(
      makeListItem({ id: 'item-1', text: 'Orange Juice', checked: false }),
    )

    render(
      <ListWidget
        listId="list-1"
        widgetId="widget-1"
        config={{ list_name: 'Groceries', list_type: 'todo' }}
      />,
    )

    await screen.findByPlaceholderText('Add item…')
    fireEvent.change(screen.getByPlaceholderText('Add item…'), { target: { value: 'Ora' } })
    // mouseDown, not click: the handler fires before the input's blur can race the re-render.
    fireEvent.mouseDown(await screen.findByRole('option'))

    await waitFor(() =>
      expect(apiMocks.apiUpdateItem).toHaveBeenCalledWith('list-1', 'item-1', { checked: false }),
    )
    expect(apiMocks.apiCreateItem).not.toHaveBeenCalled()
  })

  it('caps suggestions below the page cap, so the top of the popup survives a short card', async () => {
    apiMocks.apiGetList.mockResolvedValueOnce(
      makeListDetail({
        items: [1, 2, 3, 4, 5].map((n) =>
          makeListItem({ id: `item-${n}`, text: `Juice ${n}`, checked: true }),
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

    await screen.findByPlaceholderText('Add item…')
    fireEvent.change(screen.getByPlaceholderText('Add item…'), { target: { value: 'Juice' } })

    // Five match; the popup grows upward into a clipping card, so the widget shows fewer than the
    // page's five. Asserting the count, not the cap constant, so the reason has to keep holding.
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
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

    await screen.findByPlaceholderText('Add item…')
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

    await screen.findByPlaceholderText('Add item…')

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
