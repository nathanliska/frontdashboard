// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
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

vi.mock('../stores/toast', () => ({
  toast: {
    error: vi.fn(),
  },
}))

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

function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return {
    id: 'list-1',
    dashboard_id: 'dash-1',
    name: 'Groceries',
    list_type: 'todo',
    archived: false,
    created_by: 'user-1',
    created_at: '2026-05-05T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
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
    due_date: '2026-05-05',
    priority: null,
    category: null,
    assigned_to: null,
    created_by: 'user-1',
    created_at: '2026-05-05T00:00:00Z',
    updated_at: '2026-05-05T00:00:00Z',
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
