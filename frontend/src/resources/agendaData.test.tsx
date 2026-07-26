// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { makeListItem as baseListItem, makeListSummary as baseListSummary } from '../test/fixtures'
import { handleAgendaResourceEvent, resetAgendaData, useAgendaItems } from './agendaData'
import { __resetListDataForTests, handleListResourceEvent } from './listData'

const { apiListOccurrences } = vi.hoisted(() => ({
  apiListOccurrences: vi.fn(),
}))

const {
  apiGetList,
  apiGetLists,
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiUpdateItem,
  apiUpdateList,
} = vi.hoisted(() => ({
  apiGetList: vi.fn(),
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
  apiGetLists,
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiUpdateItem,
  apiUpdateList,
}))

vi.mock('../stores/toast', async () => (await import('../test/toast')).toastMock())

function makeOccurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    event_id: 'event-1',
    occurrence_start: '2026-05-05T14:00:00Z',
    occurrence_end: '2026-05-05T15:00:00Z',
    original_start: '2026-05-05T14:00:00Z',
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
    apiGetLists.mockResolvedValue([makeListSummary()])
    apiGetList.mockResolvedValueOnce(makeListDetail())

    render(<AgendaProbe />)

    await screen.findByText('Launch review')
    await screen.findByText('Buy milk')

    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetLists).toHaveBeenCalledTimes(1)
    expect(apiGetList).toHaveBeenCalledTimes(1)

    act(() => {
      handleAgendaResourceEvent(makeCalendarUpdatedEvent())
    })

    await screen.findByText('Updated review')
    expect(apiListOccurrences).toHaveBeenCalledTimes(2)
    expect(apiGetLists).toHaveBeenCalledTimes(1)
    expect(apiGetList).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Buy milk')).toBeInTheDocument()
  })

  it('refetches the agenda when the local day rolls over, but not on mount (#12)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 6, 19, 23, 59, 0)) // Jul 19, 23:59 local
      apiListOccurrences.mockResolvedValue([makeOccurrence()])
      apiGetLists.mockResolvedValue([makeListSummary()])
      apiGetList.mockResolvedValue(makeListDetail())

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
    apiGetLists.mockResolvedValue([makeListSummary()])
    apiGetList
      .mockResolvedValueOnce(makeListDetail())
      .mockResolvedValueOnce(makeListDetail({ items: [makeListItem({ checked: true })] }))

    render(<AgendaProbe />)

    await screen.findByText('Buy milk')
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetLists).toHaveBeenCalledTimes(1)
    expect(apiGetList).toHaveBeenCalledTimes(1)

    const event = makeListItemCheckedEvent()
    act(() => {
      handleListResourceEvent(event)
      handleAgendaResourceEvent(event)
    })

    await screen.findByText('Launch review')
    expect(screen.queryByText('Buy milk')).not.toBeInTheDocument()
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetLists).toHaveBeenCalledTimes(1)
  })
})
