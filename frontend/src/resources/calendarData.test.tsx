// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import { useAuthStore } from '../stores/auth'
import { CLIENT_INSTANCE_ID, isOwnFrame } from '../utils/shared/clientInstance'
import {
  getCalendarEvent,
  handleCalendarResourceEvent,
  resetCalendarData,
  updateCalendarEvent,
  useCalendarOccurrences,
} from './calendarData'

const { apiCreateEvent, apiDeleteEvent, apiGetEvent, apiListOccurrences, apiUpdateEvent } =
  vi.hoisted(() => ({
    apiCreateEvent: vi.fn(),
    apiDeleteEvent: vi.fn(),
    apiGetEvent: vi.fn(),
    apiListOccurrences: vi.fn(),
    apiUpdateEvent: vi.fn(),
  }))

vi.mock('../api/calendar', () => ({
  apiCreateEvent,
  apiDeleteEvent,
  apiGetEvent,
  apiListOccurrences,
  apiUpdateEvent,
}))

vi.mock('../stores/toast', async () => (await import('../test/toast')).toastMock())

function makeOccurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    event_id: 'event-1',
    occurrence_start: '2026-04-05T14:00:00Z',
    occurrence_end: '2026-04-05T15:00:00Z',
    original_start: '2026-04-05T14:00:00Z',
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

function makeEvent(overrides: Partial<import('../api/calendar').CalendarEvent> = {}) {
  return {
    id: 'event-1',
    dashboard_id: 'dash-1',
    title: 'Launch review',
    description: null,
    location: null,
    starts_at: '2026-04-05T14:00:00Z',
    ends_at: '2026-04-05T15:00:00Z',
    timezone: 'UTC',
    all_day: false,
    created_by: 'user-1',
    updated_by: 'user-1',
    recurrence: null,
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

function CalendarProbe() {
  const { data, loading, error } = useCalendarOccurrences(
    '2026-04-01T00:00:00Z',
    '2026-05-01T00:00:00Z',
    'dash-1',
  )

  return (
    <div>
      <p data-testid="calendar-loading">{loading ? 'loading' : 'idle'}</p>
      <p data-testid="calendar-error">{error ? error.message : 'none'}</p>
      {data?.map((occurrence) => (
        <p key={occurrence.event_id}>{occurrence.title}</p>
      ))}
    </div>
  )
}

describe('calendarData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCalendarData()
  })

  it('keeps occurrences visible during a background revalidation', async () => {
    const updatedOccurrence = makeOccurrence({
      title: 'Updated launch review',
      occurrence_start: '2026-04-05T15:00:00Z',
      occurrence_end: '2026-04-05T16:00:00Z',
      original_start: '2026-04-05T15:00:00Z',
    })
    const refreshRequest = deferred<CalendarOccurrence[]>()

    apiListOccurrences
      .mockResolvedValueOnce([makeOccurrence()])
      .mockReturnValueOnce(refreshRequest.promise)

    render(<CalendarProbe />)

    await screen.findByText('Launch review')
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)

    act(() => {
      handleCalendarResourceEvent({
        event_id: 1,
        event_type: 'calendar.event.updated',
        entity_type: 'calendar_event',
        entity_id: 'event-1',
        entity_version: 1,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1' },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Launch review')).toBeInTheDocument()
    expect(screen.getByTestId('calendar-loading')).toHaveTextContent('idle')

    await act(async () => {
      refreshRequest.resolve([updatedOccurrence])
      await refreshRequest.promise
    })

    await screen.findByText('Updated launch review')
  })

  it('revalidates active calendar scopes on resync', async () => {
    apiListOccurrences
      .mockResolvedValueOnce([makeOccurrence()])
      .mockResolvedValueOnce([makeOccurrence({ title: 'Resynced event' })])

    render(<CalendarProbe />)

    await screen.findByText('Launch review')

    act(() => {
      handleCalendarResourceEvent({ event_type: 'resync', payload: {} } as never)
    })

    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(2))
    await screen.findByText('Resynced event')
  })

  it('reuses cached event details when reopening the same calendar event editor', async () => {
    apiGetEvent.mockResolvedValue(makeEvent())

    const first = await getCalendarEvent('event-1')
    const second = await getCalendarEvent('event-1')

    expect(first).toEqual(second)
    expect(apiGetEvent).toHaveBeenCalledTimes(1)
  })

  it('invalidates cached event details after calendar SSE updates', async () => {
    apiGetEvent
      .mockResolvedValueOnce(makeEvent({ title: 'Launch review' }))
      .mockResolvedValueOnce(makeEvent({ title: 'Updated launch review' }))

    await getCalendarEvent('event-1')

    act(() => {
      handleCalendarResourceEvent({
        event_id: 1,
        event_type: 'calendar.event.updated',
        entity_type: 'calendar_event',
        entity_id: 'event-1',
        entity_version: 2,
        actor_id: 'other-user',
        actor_display_name: 'Other User',
        payload: { dashboard_id: 'dash-1' },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    const refreshed = await getCalendarEvent('event-1')
    expect(refreshed.title).toBe('Updated launch review')
    expect(apiGetEvent).toHaveBeenCalledTimes(2)
  })

  it('suppresses the echo of an own update: no refetch, caches kept', async () => {
    useAuthStore.setState({ user: { id: 'user-1' } } as never)
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
    apiUpdateEvent.mockResolvedValue(makeEvent({ title: 'Renamed' }))

    render(<CalendarProbe />)
    await screen.findByText('Launch review')
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)

    // The mutation path itself refetches once — that is the sanctioned server-expansion fetch.
    await act(async () => {
      await updateCalendarEvent('event-1', { title: 'Renamed' })
    })
    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(2))

    // The frame comes back stamped with this tab's id, as the backend echoes the header.
    const echo = {
      event_id: 2,
      event_type: 'calendar.event.updated' as const,
      entity_type: 'calendar_event',
      entity_id: 'event-1',
      entity_version: 2,
      actor_id: 'user-1',
      actor_display_name: 'Me',
      payload: { dashboard_id: 'dash-1', origin_client_id: CLIENT_INSTANCE_ID },
      created_at: '2026-04-05T00:00:01Z',
    }
    const isOwnEcho = isOwnFrame(echo, 'user-1')
    expect(isOwnEcho).toBe(true)
    act(() => {
      handleCalendarResourceEvent(echo, { isOwnEcho })
    })

    // No third occurrences fetch, and the PATCH response is still the cached details truth.
    expect(apiListOccurrences).toHaveBeenCalledTimes(2)
    const cached = await getCalendarEvent('event-1')
    expect(cached.title).toBe('Renamed')
    expect(apiGetEvent).not.toHaveBeenCalled()

    // Another tab's stamp is foreign — same user, different tab must still refetch.
    const fromOtherTab = {
      ...echo,
      event_id: 3,
      payload: { dashboard_id: 'dash-1', origin_client_id: 'another-tab' },
    }
    const foreign = isOwnFrame(fromOtherTab, 'user-1')
    expect(foreign).toBe(false)
    act(() => {
      handleCalendarResourceEvent(fromOtherTab, { isOwnEcho: foreign })
    })
    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(3))
  })
})
