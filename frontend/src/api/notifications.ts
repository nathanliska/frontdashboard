import { z } from 'zod'
import { apiFetch } from './client'
import {
  ActivityEventResponse,
  NotificationPageResponse,
  NotificationResponse,
  UnreadCountResponse,
} from './generated/contract'
import { parseJson } from './http'

export type {
  ActivityEventResponse as ActivityEvent,
  NotificationResponse as Notification,
} from './generated/contract'

export async function apiGetNotifications(
  cursor?: string | null,
): Promise<NotificationPageResponse> {
  // Keyset-paginated: pass the previous page's next_cursor to walk older history.
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const res = await apiFetch(`/api/notifications${q}`)
  if (!res.ok) throw new Error('Failed to load notifications')
  return parseJson(res, NotificationPageResponse)
}

export async function apiGetUnreadCount(): Promise<number> {
  const res = await apiFetch('/api/notifications/unread-count')
  if (!res.ok) return 0
  return (await parseJson(res, UnreadCountResponse)).count
}

export async function apiMarkRead(id: string): Promise<NotificationResponse> {
  const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' })
  if (!res.ok) throw new Error('Failed to mark notification read')
  return parseJson(res, NotificationResponse)
}

export async function apiMarkAllRead(): Promise<void> {
  const res = await apiFetch('/api/notifications/read-all', { method: 'PATCH' })
  if (!res.ok) throw new Error('Failed to mark all read')
}

export async function apiGetActivity(params?: {
  /** Repeated, not comma-joined: the endpoint reads `event_type` as a list. Empty asks for the default view. */
  eventTypes?: readonly string[]
  before_event_id?: number
}): Promise<ActivityEventResponse[]> {
  const q = new URLSearchParams()
  for (const eventType of params?.eventTypes ?? []) q.append('event_type', eventType)
  if (params?.before_event_id != null) q.set('before_event_id', String(params.before_event_id))
  const res = await apiFetch(`/api/activity${q.size ? `?${q}` : ''}`)
  if (!res.ok) throw new Error('Failed to load activity')
  return parseJson(res, z.array(ActivityEventResponse))
}
