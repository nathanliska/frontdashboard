import { z } from 'zod'
import { apiFetch } from './client'
import {
  CalendarEventResponse,
  type CalendarEventUpdate,
  CalendarOccurrenceResponse,
  ResourceAccessResponse,
  ShareResponse,
} from './generated/contract'
import { parseJson } from './http'
import type { ResourceAccessSummary, ResourceShare, ShareCreate, ShareUpdate } from './shares'

const occurrenceRequests = new Map<string, Promise<CalendarOccurrence[]>>()

// The generated `RecurrenceRule.frequency` is a plain `string` (the backend models it as a
// free-form field), looser than this hand `RecurrenceFrequency` literal union that
// calendarEditorDraftUtils relies on for switch narrowing and draft typing. Kept hand-written
// for now (deferred, same as the widget union in dashboards.ts) — responses are still validated
// against the generated `CalendarEventResponse`/`CalendarOccurrenceResponse` schemas below.
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

/**
 * The generated contract, not a hand-written shape. The hand-written one declared
 * `description?: string` and `location?: string`, so `null` was not expressible and clearing
 * either field was impossible to send — the caller could only omit the key, which PATCH reads as
 * "leave unchanged". `recurrence` had already been widened to `| null` for exactly this reason,
 * one field at a time. Generated types make that a compile error instead (ADR-018).
 */
export type UpdateCalendarEventInput = CalendarEventUpdate

async function readError(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return new Error(data.detail ?? fallback)
}

async function parseEvent(res: Response): Promise<CalendarEvent> {
  return (await parseJson(res, CalendarEventResponse)) as unknown as CalendarEvent
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
