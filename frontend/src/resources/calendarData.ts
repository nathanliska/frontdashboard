import { useMemo } from 'react'
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
import type { SseEvent } from '../hooks/useSSE'
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

function getEventPayload(event: SseEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === 'object' ? event.payload : null
}

function getDashboardId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.dashboard_id === 'string' ? payload.dashboard_id : null
}

function invalidateDashboardOccurrences(dashboardId: string | null): void {
  calendarOccurrencesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
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
  try {
    return await apiGetEvent(eventId)
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
    invalidateDashboardOccurrences(dashboardId)
    toast.success('Event deleted.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete event.'
    toast.error(message)
    throw error
  }
}

export function handleCalendarResourceEvent(event: SseEvent): void {
  if (event.event_type === 'resync') {
    calendarOccurrencesQuery.invalidateWhere(() => true)
    return
  }

  if (!event.event_type.startsWith('calendar.')) return

  invalidateDashboardOccurrences(getDashboardId(event))
}

export function __resetCalendarDataForTests(): void {
  calendarOccurrencesQuery.reset()
}
