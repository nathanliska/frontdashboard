import { useMemo } from 'react'
import {
  apiCreateEvent,
  apiDeleteEvent,
  apiGetEvent,
  apiListOccurrences,
  apiUpdateEvent,
  type CalendarEvent,
  type CalendarOccurrence,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
} from '../api/calendar'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import { toast } from '../stores/toast'
import { createScopedQuery } from './scopedQuery'

type CalendarOccurrencesScope = {
  windowStart: string
  windowEnd: string
  dashboardId: string | null
}

const calendarOccurrencesQuery = createScopedQuery<CalendarOccurrencesScope, CalendarOccurrence[]>({
  getKey: (scope) => `${scope.dashboardId ?? 'personal'}:${scope.windowStart}:${scope.windowEnd}`,
  fetcher: (scope) =>
    apiListOccurrences({
      windowStart: scope.windowStart,
      windowEnd: scope.windowEnd,
      dashboardId: scope.dashboardId,
    }),
  fallbackErrorMessage: 'Failed to load calendar events.',
})

const calendarEventDetails = new Map<string, CalendarEvent>()
const calendarEventRequests = new Map<string, Promise<CalendarEvent>>()

function getDashboardId(event: SseEvent): string | null {
  return event.payload.dashboard_id ?? null
}

function invalidateDashboardOccurrences(dashboardId: string | null): void {
  calendarOccurrencesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
}

function invalidateCalendarEvent(eventId: string | null): void {
  if (!eventId) return
  calendarEventDetails.delete(eventId)
  calendarEventRequests.delete(eventId)
}

export function useCalendarOccurrences(
  windowStart: string | null,
  windowEnd: string | null,
  dashboardId: string | null,
) {
  const scope = useMemo<CalendarOccurrencesScope | null>(() => {
    if (!windowStart || !windowEnd) return null
    return { windowStart, windowEnd, dashboardId }
  }, [dashboardId, windowEnd, windowStart])

  return calendarOccurrencesQuery.useQuery(scope)
}

export async function createCalendarEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
  try {
    const event = await apiCreateEvent(input)
    calendarEventDetails.set(event.id, event)
    invalidateDashboardOccurrences(event.dashboard_id ?? input.dashboard_id ?? null)
    toast.success('Event created.')
    return event
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create event.'
    toast.error(message)
    throw error
  }
}

export async function getCalendarEvent(eventId: string): Promise<CalendarEvent> {
  const existingEvent = calendarEventDetails.get(eventId)
  if (existingEvent) {
    return existingEvent
  }

  const inFlightRequest = calendarEventRequests.get(eventId)
  if (inFlightRequest) {
    return inFlightRequest
  }

  try {
    const request = apiGetEvent(eventId)
      .then((event) => {
        calendarEventDetails.set(eventId, event)
        return event
      })
      .finally(() => {
        calendarEventRequests.delete(eventId)
      })
    calendarEventRequests.set(eventId, request)
    return await request
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load event.'
    toast.error(message)
    throw error
  }
}

export async function updateCalendarEvent(
  eventId: string,
  input: UpdateCalendarEventInput,
): Promise<CalendarEvent> {
  try {
    const event = await apiUpdateEvent(eventId, input)
    calendarEventDetails.set(eventId, event)
    invalidateDashboardOccurrences(event.dashboard_id)
    toast.success('Event updated.')
    return event
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update event.'
    toast.error(message)
    throw error
  }
}

export async function deleteCalendarEvent(
  eventId: string,
  dashboardId: string | null,
): Promise<void> {
  try {
    await apiDeleteEvent(eventId)
    invalidateCalendarEvent(eventId)
    invalidateDashboardOccurrences(dashboardId)
    toast.success('Event deleted.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete event.'
    toast.error(message)
    throw error
  }
}

export function handleCalendarResourceEvent(event: ResourceEvent): void {
  if (event.event_type === 'resync') {
    calendarOccurrencesQuery.invalidateWhere(() => true)
    calendarEventDetails.clear()
    calendarEventRequests.clear()
    return
  }

  if (!event.event_type.startsWith('calendar.')) return

  invalidateCalendarEvent(event.entity_id)
  invalidateDashboardOccurrences(getDashboardId(event))
}

export function resetCalendarData(): void {
  calendarOccurrencesQuery.reset()
  calendarEventDetails.clear()
  calendarEventRequests.clear()
}
