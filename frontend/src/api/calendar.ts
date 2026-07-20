import { apiFetch } from './client'
import type { ResourceAccessSummary, ResourceShare, ShareCreate, ShareUpdate } from './shares'

const occurrenceRequests = new Map<string, Promise<CalendarOccurrence[]>>()

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface RecurrenceRule {
  frequency: RecurrenceFrequency
  interval: number
  by_weekday?: number[]
  until?: string
  count?: number
}

export interface CalendarEvent {
  id: string
  dashboard_id: string
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string
  timezone: string
  all_day: boolean
  created_by: string
  updated_by: string
  recurrence: RecurrenceRule | null
  created_at: string
  updated_at: string
}

export interface CalendarOccurrence {
  event_id: string
  occurrence_start: string
  occurrence_end: string
  original_start: string
  title: string
  description: string | null
  location: string | null
  timezone: string
  all_day: boolean
  created_by: string
  recurring: boolean
  is_exception: boolean
}

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
  shares?: ShareCreate[]
}

export interface UpdateCalendarEventInput {
  title?: string
  description?: string
  location?: string
  starts_at?: string
  ends_at?: string
  timezone?: string
  all_day?: boolean
  recurrence?: RecurrenceRule | null
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return new Error(data.detail ?? fallback)
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
    return res.json() as Promise<CalendarOccurrence[]>
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
  return res.json() as Promise<CalendarEvent>
}

export async function apiGetEvent(eventId: string): Promise<CalendarEvent> {
  const res = await apiFetch(`/api/calendar/events/${eventId}`)
  if (!res.ok) throw await readError(res, 'Failed to load event')
  return res.json() as Promise<CalendarEvent>
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
  return res.json() as Promise<CalendarEvent>
}

export async function apiDeleteEvent(eventId: string): Promise<void> {
  const res = await apiFetch(`/api/calendar/events/${eventId}`, { method: 'DELETE' })
  if (!res.ok) throw await readError(res, 'Failed to delete event')
}

/**
 * @knipignore Child-resource sharing is dashboard-inherited: the backend
 * `/calendar/events/{id}/shares` endpoints are deliberate 409 stubs, so these wrappers are
 * intentionally unused scaffolding rather than dead code. See CLAUDE.md "Sharing model".
 */
export async function apiGetEventShares(eventId: string): Promise<ResourceAccessSummary> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares`)
  if (!res.ok) throw await readError(res, 'Failed to load event shares')
  return res.json() as Promise<ResourceAccessSummary>
}

/** @knipignore Unused scaffolding — see the note on apiGetEventShares above. */
export async function apiAddEventShare(eventId: string, body: ShareCreate): Promise<ResourceShare> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res, 'Failed to add event share')
  return res.json() as Promise<ResourceShare>
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
  return res.json() as Promise<ResourceShare>
}

/** @knipignore Unused scaffolding — see the note on apiGetEventShares above. */
export async function apiRemoveEventShare(eventId: string, shareId: string): Promise<void> {
  const res = await apiFetch(`/api/calendar/events/${eventId}/shares/${shareId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw await readError(res, 'Failed to remove event share')
}
