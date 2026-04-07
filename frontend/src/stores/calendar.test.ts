import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import { useCalendarStore } from './calendar'

const { apiCreateEvent, apiDeleteEvent, apiGetEvent, apiListOccurrences, apiUpdateEvent } =
  vi.hoisted(() => ({
    apiCreateEvent: vi.fn(),
    apiDeleteEvent: vi.fn(),
    apiGetEvent: vi.fn(),
    apiListOccurrences: vi.fn(),
    apiUpdateEvent: vi.fn(),
  }))

const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('../api/calendar', () => ({
  apiCreateEvent,
  apiDeleteEvent,
  apiGetEvent,
  apiListOccurrences,
  apiUpdateEvent,
}))

vi.mock('./toast', () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
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

describe('useCalendarStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCalendarStore.setState({
      occurrences: [],
      loading: false,
      windowStart: null,
      windowEnd: null,
      dashboardId: null,
    })
  })

  it('keeps occurrences visible during a background refresh', async () => {
    const initialOccurrence = makeOccurrence()
    const updatedOccurrence = makeOccurrence({
      title: 'Updated launch review',
      occurrence_start: '2026-04-05T15:00:00Z',
      occurrence_end: '2026-04-05T16:00:00Z',
      original_start: '2026-04-05T15:00:00Z',
    })
    const request = deferred<CalendarOccurrence[]>()

    apiListOccurrences.mockReturnValue(request.promise)

    useCalendarStore.setState({
      occurrences: [initialOccurrence],
      loading: false,
      windowStart: '2026-04-01T00:00:00Z',
      windowEnd: '2026-05-01T00:00:00Z',
      dashboardId: 'dash-1',
    })

    const loadPromise = useCalendarStore
      .getState()
      .loadOccurrences('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', 'dash-1', {
        background: true,
      })

    expect(useCalendarStore.getState().loading).toBe(false)
    expect(useCalendarStore.getState().occurrences).toEqual([initialOccurrence])

    request.resolve([updatedOccurrence])
    await loadPromise

    expect(useCalendarStore.getState().loading).toBe(false)
    expect(useCalendarStore.getState().occurrences).toEqual([updatedOccurrence])
  })
})
