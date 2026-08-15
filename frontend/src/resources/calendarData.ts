import {
  apiCreateEvent,
  apiDeleteEvent,
  apiGetEvent,
  apiPurgeEvent,
  apiRestoreEvent,
  apiUpdateEvent,
  type CalendarEvent,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
} from '../api/calendar'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import { toast } from '../stores/toast'
import {
  invalidateAllOccurrences,
  invalidateOccurrences,
  resetOccurrences,
  useOccurrences,
} from './occurrenceStore'
import { registerResourceReset } from './resetRegistry'

const calendarEventDetails = new Map<string, CalendarEvent>()
const calendarEventRequests = new Map<string, Promise<CalendarEvent>>()

function getDashboardId(event: SseEvent): string | null {
  return event.payload.dashboard_id ?? null
}

function invalidateDashboardOccurrences(dashboardId: string | null): void {
  invalidateOccurrences(dashboardId)
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
  return useOccurrences(dashboardId, windowStart, windowEnd)
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
    toast.success('Event deleted.', {
      label: 'Undo',
      onAction: () => void restoreCalendarEvent(eventId, dashboardId),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete event.'
    toast.error(message)
    throw error
  }
}

/**
 * Undo a delete, restoring the event with its recurrence, overrides and participants intact.
 *
 * Occurrences are invalidated rather than patched: the server expands recurrence, so what the
 * restored event contributes to a window is not something the client can compute.
 */
export async function restoreCalendarEvent(
  eventId: string,
  dashboardId: string | null,
): Promise<boolean> {
  try {
    const event = await apiRestoreEvent(eventId)
    calendarEventDetails.set(eventId, event)
    invalidateDashboardOccurrences(dashboardId)
    toast.success('Event restored.')
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restore event.'
    toast.error(message)
    return false
  }
}

/** Delete a trashed event outright. Occurrences already exclude it, so nothing is invalidated. */
export async function purgeCalendarEvent(eventId: string): Promise<boolean> {
  try {
    await apiPurgeEvent(eventId)
    calendarEventDetails.delete(eventId)
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to permanently delete event.')
    return false
  }
}

export function handleCalendarResourceEvent(
  event: ResourceEvent,
  { isOwnEcho = false }: { isOwnEcho?: boolean } = {},
): void {
  if (event.event_type === 'resync') {
    invalidateAllOccurrences()
    calendarEventDetails.clear()
    calendarEventRequests.clear()
    return
  }

  if (!event.event_type.startsWith('calendar.')) return

  // The mutation path already refetched occurrences after the commit and cached the response as
  // the event's truth — this frame adds nothing, and acting on it would throw that cache away.
  if (isOwnEcho) return

  invalidateCalendarEvent(event.entity_id)
  invalidateDashboardOccurrences(getDashboardId(event))
}

export function resetCalendarData(): void {
  resetOccurrences()
  calendarEventDetails.clear()
  calendarEventRequests.clear()
}

registerResourceReset(resetCalendarData)
