// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { makeListItem as baseListItem, makeListSummary as baseListSummary } from '../test/fixtures'
import { handleAgendaResourceEvent, resetAgendaData, useAgendaItems } from './agendaData'
import { handleCalendarResourceEvent } from './calendarData'
import {
  __resetListDataForTests,
  __seedListDetailForTests,
  handleListResourceEvent,
  updateListItem,
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
    // The last PATCH-then-GET pair. Checking an item in a list widget applied the response to the
    // list cache and then refetched the whole agenda anyway, because this handler saw the echo of
    // our own mutation and had no way to recognise it — `handleListResourceEvent` had already
    // consumed the pending id. Now the router decides once and both are told.
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

  it('still refetches reminders when someone else checks an item', async () => {
    // The suppression must be scoped to our *own* mutations. Another user's change carries no
    // pending id of ours, so it is not derivable and the refetch stays.
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
    // The other direction of `applyAgendaItemUpdate`. Until the due-date picker existed nothing in
    // the UI could set a date, so entries could only ever *leave* the agenda this way — the docs in
    // agendaData.ts said as much. Now an item can arrive, and it has to arrive from the mutation
    // response rather than a refetch, or we are back to the PATCH-then-GET pair.
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
})
