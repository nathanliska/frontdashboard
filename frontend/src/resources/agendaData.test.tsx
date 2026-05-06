// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { useAuthStore } from '../stores/auth'
import { handleAgendaResourceEvent, resetAgendaData, useAgendaItems } from './agendaData'
import { __resetListDataForTests, handleListResourceEvent, updateListItem } from './listData'

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

function makeListCheckedEvent(): SseEvent {
  return {
    event_id: 1,
    event_type: 'list.item.checked',
    entity_type: 'list_item',
    entity_id: 'item-1',
    entity_version: 2,
    actor_id: 'user-1',
    actor_display_name: 'Example User',
    payload: {
      dashboard_id: 'dash-1',
      list_id: 'list-1',
      client_mutation_id: '11111111-1111-4111-8111-111111111111',
    },
    created_at: '2026-05-05T00:00:01Z',
  }
}

describe('agendaData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgendaData()
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

  it('updates reminders from cache without reloading on self-echoed list item checks', async () => {
    apiListOccurrences.mockResolvedValueOnce([makeOccurrence()])
    apiGetLists.mockResolvedValue([makeListSummary()])
    apiGetList.mockResolvedValueOnce(makeListDetail())
    apiUpdateItem.mockResolvedValueOnce(makeListItem({ checked: true }))
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    )

    render(<AgendaProbe />)

    await screen.findByText('Launch review')
    await screen.findByText('Buy milk')

    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetLists).toHaveBeenCalledTimes(1)
    expect(apiGetList).toHaveBeenCalledTimes(1)

    await act(async () => {
      await updateListItem('list-1', 'item-1', { checked: true })
    })

    const event = makeListCheckedEvent()

    act(() => {
      handleAgendaResourceEvent(event)
      handleListResourceEvent(event)
    })

    await waitFor(() => expect(screen.queryByText('Buy milk')).not.toBeInTheDocument())
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(apiGetLists).toHaveBeenCalledTimes(1)
    expect(apiGetList).toHaveBeenCalledTimes(1)
  })
})
