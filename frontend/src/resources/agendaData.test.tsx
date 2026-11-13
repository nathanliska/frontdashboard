// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import { retireListDetailRequests } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { bumpSessionGeneration } from '../stores/sessionGeneration'
import { makeListItem as baseListItem, makeListSummary as baseListSummary } from '../test/fixtures'
import { handleAgendaResourceEvent, resetAgendaData, useAgendaItems } from './agendaData'
import { handleCalendarResourceEvent } from './calendarData'
import {
  __resetListDataForTests,
  __seedListDetailForTests,
  handleListResourceEvent,
  updateListItem,
  useListDetail,
  useListSummaries,
} from './listData'

const { apiListOccurrences } = vi.hoisted(() => ({
  apiListOccurrences: vi.fn(),
}))

const {
  apiGetList,
  apiGetListDetails,
  apiGetLists,
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiUpdateItem,
  apiUpdateList,
} = vi.hoisted(() => ({
  apiGetList: vi.fn(),
  apiGetListDetails: vi.fn(),
  apiGetLists: vi.fn(),
  apiCreateItem: vi.fn(),
  apiCreateList: vi.fn(),
  apiDeleteItem: vi.fn(),
  apiDeleteList: vi.fn(),
  apiUpdateItem: vi.fn(),
  apiUpdateList: vi.fn(),
}))

vi.mock('../api/calendar', () => ({
  apiListOccurrences,
}))

vi.mock('../api/lists', () => ({
  retireListDetailRequests: vi.fn(),
  apiGetList,
  apiGetListDetails,
  apiGetLists,
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiUpdateItem,
  apiUpdateList,
}))

vi.mock('../stores/toast', async () => (await import('../test/toast')).toastMock())

// Relative to now: the agenda window is today..+8d, and the occurrence cache filters what it
// returns to the requested window, so a fixed date would fall outside it once the date passes.
const SOON = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
const SOON_END = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

function makeOccurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    event_id: 'event-1',
    occurrence_start: SOON,
    occurrence_end: SOON_END,
    original_start: SOON,
    title: 'Launch review',
    description: null,
    location: null,
    timezone: 'UTC',
    all_day: false,
    created_by: 'user-1',
    recurring: false,
    is_exception: false,
    participants: [],
    ...overrides,
  }
}

// due_date is the point of this file — an agenda entry only exists because an item is due — so
// unlike the other list fixtures this default is load-bearing, not incidental.
const AT = '2026-05-05T00:00:00Z'
const DUE = '2026-05-05'

function makeListItem(overrides: Partial<ListItem> = {}): ListItem {
  return baseListItem({
    text: 'Buy milk',
    due_date: DUE,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  })
}

function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return baseListSummary({
    name: 'Groceries',
    list_type: 'todo',
    created_at: AT,
    updated_at: AT,
    ...overrides,
  })
}

function makeListDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return { ...makeListSummary(), items: [makeListItem()], ...overrides }
}

function AgendaProbe() {
  const { data, loading, error } = useAgendaItems('dash-1')

  return (
    <div>
      <p data-testid="agenda-loading">{loading ? 'loading' : 'idle'}</p>
      <p data-testid="agenda-error">{error ? error.message : 'none'}</p>
      {data?.map((item) => (
        <p key={item.id}>{item.title}</p>
      ))}
    </div>
  )
}

function makeListItemCheckedEvent(): SseEvent {
  return {
    event_id: 2,
    event_type: 'list.item.checked',
    entity_type: 'list_item',
    entity_id: 'item-1',
    entity_version: 2,
    actor_id: 'user-2',
    actor_display_name: 'Example User',
    payload: {
      dashboard_id: 'dash-1',
      list_id: 'list-1',
    },
    created_at: '2026-05-05T00:00:02Z',
  }
}

function makeCalendarUpdatedEvent(): SseEvent {
  return {
    event_id: 1,
    event_type: 'calendar.event.updated',
    entity_type: 'calendar_event',
    entity_id: 'event-1',
    entity_version: 2,
    actor_id: 'user-2',
    actor_display_name: 'Example User',
    payload: {
      dashboard_id: 'dash-1',
      title: 'Updated review',
    },
    created_at: '2026-05-05T00:00:01Z',
  }
}

describe('agendaData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgendaData()
    __resetListDataForTests()
  })

  it('refreshes calendar agenda items without reloading list reminders on calendar events', async () => {
    apiListOccurrences
      .mockResolvedValueOnce([makeOccurrence()])
      .mockResolvedValueOnce([makeOccurrence({ title: 'Updated review' })])
    apiGetListDetails.mockResolvedValueOnce([makeListDetail()])

    render(<AgendaProbe />)

    await screen.findByText('Launch review')
    await screen.findByText('Buy milk')

    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)

    // Both handlers, as useSSE routes it: occurrences live in the shared store that
    // handleCalendarResourceEvent owns, while the agenda handler covers reminders.
    act(() => {
      handleCalendarResourceEvent(makeCalendarUpdatedEvent())
      handleAgendaResourceEvent(makeCalendarUpdatedEvent())
    })

    await screen.findByText('Updated review')
    expect(apiListOccurrences).toHaveBeenCalledTimes(2)
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Buy milk')).toBeInTheDocument()
  })

  it('refetches the agenda when the local day rolls over, but not on mount', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 6, 19, 23, 59, 0)) // Jul 19, 23:59 local
      apiListOccurrences.mockResolvedValue([makeOccurrence()])
      apiGetListDetails.mockResolvedValue([makeListDetail()])

      render(<AgendaProbe />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0) // flush the initial fetch
      })
      // The rollover effect must NOT fire on mount.
      expect(apiListOccurrences).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000) // cross midnight into Jul 20
      })
      // Day rolled over → agenda invalidated → refetch.
      expect(apiListOccurrences).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes list reminders without reloading calendar occurrences on list events', async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails
      .mockResolvedValueOnce([makeListDetail()])
      .mockResolvedValueOnce([makeListDetail({ items: [makeListItem({ checked: true })] })])

    render(<AgendaProbe />)

    await screen.findByText('Buy milk')
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)

    const event = makeListItemCheckedEvent()
    act(() => {
      handleListResourceEvent(event)
      handleAgendaResourceEvent(event)
    })

    await screen.findByText('Launch review')
    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it('patches reminders from our own item check instead of refetching them', async () => {
    // Checking an item must not refetch the agenda: the router decides the echo once and tells both
    // handlers, since the list handler has already consumed the pending id.
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails.mockResolvedValueOnce([makeListDetail()])
    __seedListDetailForTests('list-1', makeListDetail())
    apiUpdateItem.mockResolvedValueOnce(makeListItem({ checked: true }))

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)

    await act(async () => {
      await updateListItem('list-1', 'item-1', { checked: true })
    })

    // Derived locally with the same transform the fetcher uses: a checked item is not a reminder.
    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()

    act(() => {
      const event = makeListItemCheckedEvent()
      handleListResourceEvent(event, { isOwnEcho: true })
      handleAgendaResourceEvent(event, { isOwnEcho: true })
    })

    // The whole point: still one fetch. Asserting on the count rather than the rendering,
    // because the rendered agenda looks identical whether it was patched or refetched.
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
  })

  it('still refetches reminders when a foreign check carries no values to patch from', async () => {
    // An event with no `values` cannot be applied locally by either handler, so the read stays.
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails
      .mockResolvedValueOnce([makeListDetail()])
      .mockResolvedValueOnce([makeListDetail({ items: [makeListItem({ checked: true })] })])

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)

    act(() => {
      handleAgendaResourceEvent(makeListItemCheckedEvent(), { isOwnEcho: false })
    })

    await screen.findByText('Launch review')
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it('an item that gains a due date joins the agenda without a refetch', async () => {
    // An item gaining a due date has to arrive in the agenda from the mutation response, not a
    // refetch.
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    const undated = makeListDetail({ items: [makeListItem({ due_date: null })] })
    apiGetListDetails.mockResolvedValueOnce([undated])
    __seedListDetailForTests('list-1', undated)
    apiUpdateItem.mockResolvedValueOnce(makeListItem({ due_date: DUE }))

    render(<AgendaProbe />)
    await screen.findByText('Launch review')
    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)

    await act(async () => {
      await updateListItem('list-1', 'item-1', { due_date: DUE })
    })

    expect(screen.getByText('Buy milk')).toBeInTheDocument()
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it("patches reminders from someone else's check instead of reloading every list", async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails.mockResolvedValueOnce([makeListDetail()])
    __seedListDetailForTests('list-1', makeListDetail())

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    act(() => {
      const event = makeListItemCheckedEvent()
      event.payload = { ...event.payload, values: { checked: true } }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
    // The count is the point: a reload renders the same agenda this patch does.
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('reads the reminders again when the checked item belongs to a list this tab does not hold', async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails
      .mockResolvedValueOnce([makeListDetail()])
      .mockResolvedValueOnce([makeListDetail({ items: [makeListItem({ checked: true })] })])

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    act(() => {
      const event = makeListItemCheckedEvent()
      event.payload = { ...event.payload, values: { checked: true } }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    await screen.findByText('Launch review')
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it("drops a reminder when someone else deletes its item, without holding the item's list", async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails.mockResolvedValueOnce([makeListDetail()])

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    act(() => {
      const event: SseEvent = { ...makeListItemCheckedEvent(), event_type: 'list.item.deleted' }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('reads the reminders again when a delete does not say which list it was in', async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails
      .mockResolvedValueOnce([makeListDetail()])
      .mockResolvedValueOnce([makeListDetail({ items: [] })])

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    act(() => {
      const event: SseEvent = { ...makeListItemCheckedEvent(), event_type: 'list.item.deleted' }
      event.payload = { ...event.payload, list_id: undefined }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    await waitFor(() => expect(screen.queryByText('Buy milk')).not.toBeInTheDocument())
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it('reloads reminders whose first load was still in flight when an item was deleted', async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    let resolve: (lists: ListDetail[]) => void = () => {}
    apiGetListDetails
      .mockReturnValueOnce(new Promise<ListDetail[]>((r) => (resolve = r)))
      .mockResolvedValueOnce([makeListDetail({ items: [] })])
    const first = render(<AgendaProbe />)

    act(() => {
      const event: SseEvent = { ...makeListItemCheckedEvent(), event_type: 'list.item.deleted' }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })
    await act(async () => {
      resolve([makeListDetail()])
    })

    // The response predates the delete, so the next look at the agenda must not trust it.
    first.unmount()
    render(<AgendaProbe />)
    await waitFor(() => expect(apiGetListDetails).toHaveBeenCalledTimes(2))
  })

  it('reads the reminders again rather than rebuild one from a list it knows is out of date', async () => {
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiGetListDetails
      .mockResolvedValueOnce([makeListDetail()])
      .mockResolvedValueOnce([makeListDetail({ items: [makeListItem({ checked: true })] })])
    __seedListDetailForTests('list-1', makeListDetail())

    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    act(() => {
      // Nothing is showing the list, so a resync only marks it stale.
      handleListResourceEvent({ ...makeListItemCheckedEvent(), event_type: 'resync' })
      const event = makeListItemCheckedEvent()
      event.payload = { ...event.payload, values: { checked: true } }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    await screen.findByText('Launch review')
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })
})

function ListProbe({ listId }: { listId: string }) {
  const { data } = useListDetail(listId, 'dash-1')
  return <p>{`${listId}:${data ? data.name : 'pending'}`}</p>
}

function CountProbe({ listId }: { listId: string }) {
  const { data } = useListDetail(listId)
  return <p>{data ? `count:${data.item_count} items:${data.items.length}` : 'pending'}</p>
}

function PickerProbe() {
  const { data } = useListSummaries('dash-1', { withItems: true })
  return <p>{`picker:${data ? data.map((list) => list.name).join(',') : 'pending'}`}</p>
}

describe("a dashboard's lists load once", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgendaData()
    __resetListDataForTests()
    apiGetListDetails.mockResolvedValue([
      makeListDetail({ id: 'list-1', name: 'Groceries' }),
      makeListDetail({ id: 'list-2', name: 'Chores' }),
    ])
  })

  it('answers a second list and the picker from the batch the first list loaded', async () => {
    render(<ListProbe listId="list-1" />)
    await screen.findByText('list-1:Groceries')

    render(<ListProbe listId="list-2" />)
    render(<PickerProbe />)
    await screen.findByText('list-2:Chores')
    await screen.findByText('picker:Groceries,Chores')

    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
    expect(apiGetList).not.toHaveBeenCalled()
    expect(apiGetLists).not.toHaveBeenCalled()
  })

  it('leaves a list bound from the picker with nothing to fetch', async () => {
    render(<PickerProbe />)
    await screen.findByText('picker:Groceries,Chores')

    render(<ListProbe listId="list-2" />)
    await screen.findByText('list-2:Chores')

    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
    expect(apiGetList).not.toHaveBeenCalled()
  })

  it('refetches one held list on its own, not the whole dashboard', async () => {
    apiGetList.mockResolvedValue(makeListDetail({ id: 'list-1', name: 'Renamed' }))
    render(<ListProbe listId="list-1" />)
    await screen.findByText('list-1:Groceries')

    act(() => {
      const event: SseEvent = {
        ...makeListItemCheckedEvent(),
        event_type: 'list.updated',
        entity_type: 'list',
        entity_id: 'list-1',
      }
      handleListResourceEvent(event, { isOwnEcho: false })
    })

    await screen.findByText('list-1:Renamed')
    expect(apiGetList).toHaveBeenCalledTimes(1)
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('keeps a batch that outlives a sign-out from filling the next account', async () => {
    let resolve: (lists: ListDetail[]) => void = () => {}
    apiGetListDetails.mockReturnValueOnce(new Promise<ListDetail[]>((r) => (resolve = r)))
    const first = render(<ListProbe listId="list-1" />)

    first.unmount()
    bumpSessionGeneration()
    __resetListDataForTests()
    await act(async () => {
      resolve([makeListDetail({ id: 'list-1' }), makeListDetail({ id: 'list-2', name: 'Chores' })])
    })

    // Nothing was seeded, so the next account's first look at a list has to ask for it.
    render(<ListProbe listId="list-2" />)
    await screen.findByText('list-2:Chores')
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it('seeds nothing from a batch that a list event overtook', async () => {
    let resolve: (lists: ListDetail[]) => void = () => {}
    apiGetListDetails.mockReturnValueOnce(new Promise<ListDetail[]>((r) => (resolve = r)))
    render(<ListProbe listId="list-1" />)

    act(() => {
      const event: SseEvent = {
        ...makeListItemCheckedEvent(),
        event_type: 'list.updated',
        entity_type: 'list',
        entity_id: 'list-2',
      }
      handleListResourceEvent(event, { isOwnEcho: false })
    })
    await act(async () => {
      resolve([makeListDetail({ id: 'list-1' }), makeListDetail({ id: 'list-2', name: 'Stale' })])
    })

    // The batch predates the change to list-2, so list-2 has to be asked for again.
    render(<ListProbe listId="list-2" />)
    await screen.findByText('list-2:Chores')
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
    expect(retireListDetailRequests).toHaveBeenCalled()
  })

  it("appends someone else's new item to a held list and the agenda without a read", async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    const added = makeListItem({
      id: uuid(1),
      list_id: uuid(2),
      created_by: uuid(3),
      text: 'Call plumber',
    })
    apiListOccurrences.mockResolvedValue([])
    apiGetListDetails.mockResolvedValue([makeListDetail()])
    __seedListDetailForTests('list-1', makeListDetail({ item_count: 1 }))
    render(<CountProbe listId="list-1" />)
    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    const event: SseEvent = { ...makeListItemCheckedEvent(), event_type: 'list.item.created' }
    event.entity_id = added.id
    act(() => {
      event.payload = { ...event.payload, item: added }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    await screen.findByText('count:2 items:2')
    await screen.findByText('Call plumber')
    expect(apiGetList).not.toHaveBeenCalled()
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('reads the agenda again when a new item belongs to a list this tab does not hold', async () => {
    apiListOccurrences.mockResolvedValue([])
    apiGetListDetails.mockResolvedValue([makeListDetail()])
    __resetListDataForTests()
    render(<AgendaProbe />)
    await screen.findByText('Buy milk')

    act(() => {
      const event: SseEvent = { ...makeListItemCheckedEvent(), event_type: 'list.item.created' }
      event.payload = { ...event.payload, item: makeListItem() }
      handleListResourceEvent(event, { isOwnEcho: false })
      handleAgendaResourceEvent(event, { isOwnEcho: false })
    })

    await waitFor(() => expect(apiGetListDetails).toHaveBeenCalledTimes(2))
  })

  it("takes someone else's deleted item out of a held list and its count", async () => {
    __seedListDetailForTests('list-1', makeListDetail({ item_count: 1 }))
    render(<CountProbe listId="list-1" />)
    await screen.findByText('count:1 items:1')

    act(() => {
      const event: SseEvent = { ...makeListItemCheckedEvent(), event_type: 'list.item.deleted' }
      handleListResourceEvent(event, { isOwnEcho: false })
    })

    await screen.findByText('count:0 items:0')
    expect(apiGetList).not.toHaveBeenCalled()
  })
})
