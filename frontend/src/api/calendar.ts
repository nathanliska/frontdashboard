import { z } from 'zod'
import { apiFetch } from './client'
import {
  CalendarEventResponse,
  type CalendarEventUpdate,
  CalendarOccurrenceResponse,
  type RecurrenceRule,
  ResourceAccessResponse,
  ShareResponse,
  type TrashedEventCursor,
  TrashedEventPage,
  type TrashedEventSummary,
} from './generated/contract'
import { parseJson, readError } from './http'
import type { ResourceAccessSummary, ResourceShare, ShareCreate, ShareUpdate } from './shares'

const occurrenceRequests = new Map<string, Promise<CalendarOccurrence[]>>()

// The generated response shapes, aliased to the names this module's callers already use.
export type CalendarEvent = CalendarEventResponse
export type TrashedEvent = TrashedEventSummary
export type EventTrashCursor = TrashedEventCursor
export type CalendarOccurrence = CalendarOccurrenceResponse

export interface CreateCalendarEventInput {
  dashboard_id?: string
  title: string
  description?: string
  location?: string
  starts_at: string
  ends_at: string
  timezone: string
  all_day: boolean
  recurrence?: RecurrenceRule
  participants?: string[]
}

/**
 * The generated contract, not a hand-written shape: `null` has to be expressible or a cleared
 * field is unsendable, since PATCH reads an omitted key as "leave unchanged" (ADR-018).
 */
export type UpdateCalendarEventInput = CalendarEventUpdate

async function parseEvent(res: Response): Promise<CalendarEvent> {
  return parseJson(res, CalendarEventResponse)
}

export async function apiListOccurrences(params: {
  windowStart: string
  windowEnd: string
  dashboardId?: string | null
}): Promise<CalendarOccurrence[]> {
  const query = new URLSearchParams({
    window_start: params.windowStart,
    window_end: params.windowEnd,
  })
  if (params.dashboardId) query.set('dashboard_id', params.dashboardId)

  const key = query.toString()
  const existing = occurrenceRequests.get(key)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/calendar/events?${key}`)
    if (!res.ok) throw await readError(res, 'Failed to load calendar events')
    return parseJson(res, z.array(CalendarOccurrenceResponse))
  })().finally(() => {
    occurrenceRequests.delete(key)
  })

  occurrenceRequests.set(key, request)
  return request
}

export async function apiCreateEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
  const res = await apiFetch('/api/calendar/events', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await readError(res, 'Failed to create event')
  return parseEvent(res)
}

export async function apiGetEvent(eventId: string): Promise<CalendarEvent> {
  const res = await apiFetch(`/api/calendar/events/${eventId}`)
  if (!res.ok) throw await readError(res, 'Failed to load event')
  return parseEvent(res)
}

export async function apiUpdateEvent(
  eventId: string,
  input: UpdateCalendarEventInput,
): Promise<CalendarEvent> {
  const res = await apiFetch(`/api/calendar/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await readError(res, 'Failed to update event')
  return parseEvent(res)
}

export async function apiDeleteEvent(eventId: string): Promise<void> {
  const res = await apiFetch(`/api/calendar/events/${eventId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw await readError(res, 'Failed to delete event')
}

/**
 * One page of trashed events the caller can see, newest first, with their purge deadline.
 *
 * A non-null `next_cursor` on the result is the only signal that more exist; hand it straight back
 * to fetch the page after it.
 */
export async function apiGetEventTrash(
  dashboardId?: string | null,
  cursor?: EventTrashCursor | null,
): Promise<TrashedEventPage> {
  const params = new URLSearchParams()
  if (dashboardId) params.set('dashboard_id', dashboardId)
  if (cursor) {
    params.set('before', cursor.deleted_at)
    params.set('before_id', cursor.id)
  }
  const query = params.size > 0 ? `?${params}` : ''
  const res = await apiFetch(`/api/calendar/events/trash${query}`)
  if (!res.ok) throw await readError(res, 'Failed to load trashed events')
  return parseJson(res, TrashedEventPage)
}

/** Delete a trashed event outright, ahead of the reaper. */
export async function apiPurgeEvent(eventId: string): Promise<void> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/trash`, { method: 'DELETE' })
  if (!res.ok) throw await readError(res, 'Failed to permanently delete event')
}

/** Undo a delete. Returns the event as it was, recurrence and participants included. */
export async function apiRestoreEvent(eventId: string): Promise<CalendarEvent> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/restore`, {
    method: 'POST',
  })
  if (!res.ok) throw await readError(res, 'Failed to restore event')
  return parseEvent(res)
}

/**
 * @knipignore Child-resource sharing is dashboard-inherited: the backend
 * `/calendar/events/{id}/shares` endpoints are deliberate 409 stubs, so these wrappers are
 * intentionally unused scaffolding rather than dead code. See CLAUDE.md "Sharing model".
 */
export async function apiGetEventShares(eventId: string): Promise<ResourceAccessSummary> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares`)
  if (!res.ok) throw await readError(res, 'Failed to load event shares')
  return parseJson(res, ResourceAccessResponse)
}

/** @knipignore Unused scaffolding — see the note on apiGetEventShares above. */
export async function apiAddEventShare(eventId: string, body: ShareCreate): Promise<ResourceShare> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res, 'Failed to add event share')
  return parseJson(res, ShareResponse)
}

/** @knipignore Unused scaffolding — see the note on apiGetEventShares above. */
export async function apiUpdateEventShare(
  eventId: string,
  shareId: string,
  body: ShareUpdate,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares/${shareId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res, 'Failed to update event share')
  return parseJson(res, ShareResponse)
}

/** @knipignore Unused scaffolding — see the note on apiGetEventShares above. */
export async function apiRemoveEventShare(eventId: string, shareId: string): Promise<void> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares/${shareId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw await readError(res, 'Failed to remove event share')
}
