import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import {
  __resetCalendarDataForTests,
  handleCalendarResourceEvent,
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

vi.mock('../stores/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

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
    __resetCalendarDataForTests()
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
})
