import { create } from 'zustand'
import {
  type CalendarEvent,
  type CalendarOccurrence,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
  apiCreateEvent,
  apiDeleteEvent,
  apiGetEvent,
  apiListOccurrences,
  apiUpdateEvent,
} from '../api/calendar'
import { toast } from './toast'

let inFlightOccurrencesLoad: { key: string; promise: Promise<void> } | null = null

type LoadOccurrencesOptions = {
  background?: boolean
}

interface CalendarState {
  occurrences: CalendarOccurrence[]
  loading: boolean
  windowStart: string | null
  windowEnd: string | null
  dashboardId: string | null
  loadOccurrences: (
    windowStart: string,
    windowEnd: string,
    dashboardId?: string | null,
    options?: LoadOccurrencesOptions,
  ) => Promise<void>
  createEvent: (input: CreateCalendarEventInput) => Promise<void>
  getEvent: (eventId: string) => Promise<CalendarEvent>
  updateEvent: (eventId: string, input: UpdateCalendarEventInput) => Promise<void>
  deleteEvent: (eventId: string) => Promise<void>
}

export const useCalendarStore = create<CalendarState>()((set, get) => ({
  occurrences: [],
  loading: false,
  windowStart: null,
  windowEnd: null,
  dashboardId: null,

  async loadOccurrences(windowStart, windowEnd, dashboardId = null, options = {}) {
    const scopeKey = `${dashboardId ?? 'personal'}:${windowStart}:${windowEnd}`

    if (inFlightOccurrencesLoad?.key === scopeKey) {
      return inFlightOccurrencesLoad.promise
    }

    const showLoading = !options.background
    set(
      showLoading
        ? { loading: true, windowStart, windowEnd, dashboardId }
        : { windowStart, windowEnd, dashboardId },
    )

    const promise = (async () => {
      try {
        const occurrences = await apiListOccurrences({
          windowStart,
          windowEnd,
          dashboardId,
        })
        const s = get()
        if (
          s.windowStart === windowStart &&
          s.windowEnd === windowEnd &&
          s.dashboardId === dashboardId
        ) {
          set({ occurrences })
        }
      } catch (err) {
        const s = get()
        if (
          s.windowStart === windowStart &&
          s.windowEnd === windowEnd &&
          s.dashboardId === dashboardId
        ) {
          if (showLoading) {
            toast.error(err instanceof Error ? err.message : 'Failed to load calendar events.')
          }
        }
      } finally {
        if (inFlightOccurrencesLoad?.key === scopeKey) {
          inFlightOccurrencesLoad = null
        }
        if (showLoading) {
          set({ loading: false })
        }
      }
    })()

    inFlightOccurrencesLoad = { key: scopeKey, promise }
    return promise
  },

  async createEvent(input) {
    const { windowStart, windowEnd, dashboardId: activeDashboardId } = get()
    try {
      await apiCreateEvent(input)
      if (windowStart && windowEnd) {
        await get().loadOccurrences(windowStart, windowEnd, input.dashboard_id ?? activeDashboardId)
      }
      toast.success('Event created.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create event.')
      throw err
    }
  },

  async getEvent(eventId) {
    try {
      return await apiGetEvent(eventId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load event.')
      throw err
    }
  },

  async updateEvent(eventId, input) {
    const { windowStart, windowEnd, dashboardId } = get()
    try {
      await apiUpdateEvent(eventId, input)
      if (windowStart && windowEnd) {
        await get().loadOccurrences(windowStart, windowEnd, dashboardId)
      }
      toast.success('Event updated.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update event.')
      throw err
    }
  },

  async deleteEvent(eventId) {
    const { windowStart, windowEnd, dashboardId } = get()
    try {
      await apiDeleteEvent(eventId)
      if (windowStart && windowEnd) {
        await get().loadOccurrences(windowStart, windowEnd, dashboardId)
      }
      toast.success('Event deleted.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete event.')
    }
  },
}))
