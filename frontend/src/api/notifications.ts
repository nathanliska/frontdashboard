import { apiFetch } from './client'

export interface Notification {
  id: string
  type: string
  title: string
  body: string
  reference_type: string | null
  reference_id: string | null
  read_at: string | null
  created_at: string
}

export interface ActivityEvent {
  event_id: number
  event_type: string
  entity_type: string
  entity_id: string
  actor_id: string
  actor_display_name: string
  payload: Record<string, unknown>
  created_at: string
}

export async function apiGetNotifications(): Promise<Notification[]> {
  const res = await apiFetch('/api/notifications')
  if (!res.ok) throw new Error('Failed to load notifications')
  return res.json() as Promise<Notification[]>
}

export async function apiGetUnreadCount(): Promise<number> {
  const res = await apiFetch('/api/notifications/unread-count')
  if (!res.ok) return 0
  const data = (await res.json()) as { count: number }
  return data.count
}

export async function apiMarkRead(id: string): Promise<Notification> {
  const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' })
  if (!res.ok) throw new Error('Failed to mark notification read')
  return res.json() as Promise<Notification>
}

export async function apiMarkAllRead(): Promise<void> {
  const res = await apiFetch('/api/notifications/read-all', { method: 'PATCH' })
  if (!res.ok) throw new Error('Failed to mark all read')
}

export async function apiGetActivity(params?: {
  event_type?: string
  before_event_id?: number
}): Promise<ActivityEvent[]> {
  const q = new URLSearchParams()
  if (params?.event_type) q.set('event_type', params.event_type)
  if (params?.before_event_id != null) q.set('before_event_id', String(params.before_event_id))
  const res = await apiFetch(`/api/activity${q.size ? `?${q}` : ''}`)
  if (!res.ok) throw new Error('Failed to load activity')
  return res.json() as Promise<ActivityEvent[]>
}
