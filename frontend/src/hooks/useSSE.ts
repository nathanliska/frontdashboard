import { useEffect } from 'react'
import type { Notification } from '../api/notifications'
import { useAuthStore } from '../stores/auth'
import { useCalendarStore } from '../stores/calendar'
import { useDashboardStore } from '../stores/dashboard'
import { useListsStore } from '../stores/lists'
import { useNotificationsStore } from '../stores/notifications'

export interface SseEvent {
  event_id: number
  event_type: string
  group_id: string | null
  entity_type: string
  entity_id: string
  entity_version: number
  actor_id: string
  actor_display_name: string
  payload: Record<string, unknown>
  created_at: string
}

export const APP_RESYNC_EVENT = 'frontdashboard:resync'

const LIST_EVENT_TYPES = [
  'list.created',
  'list.updated',
  'list.archived',
  'list.deleted',
  'list.item.created',
  'list.item.updated',
  'list.item.checked',
  'list.item.deleted',
] as const

const CALENDAR_EVENT_TYPES = [
  'calendar.event.created',
  'calendar.event.updated',
  'calendar.event.deleted',
  'calendar.event.occurrence.updated',
  'calendar.event.occurrence.cancelled',
] as const

const DASHBOARD_EVENT_TYPES = [
  'dashboard.created',
  'dashboard.updated',
  'dashboard.deleted',
] as const

/**
 * Opens a single SSE connection for the authenticated user and routes
 * incoming events to the appropriate Zustand store actions.
 *
 * Mount once inside the authenticated shell — closed automatically on logout.
 */
export function useSSE(): void {
  const user = useAuthStore((s) => s.user)
  const handleListEvent = useListsStore((s) => s.handleSseEvent)
  const handleDashboardEvent = useDashboardStore((s) => s.handleDashboardEvent)
  const handleDashboardContentEvent = useDashboardStore((s) => s.handleContentEvent)
  const addNotification = useNotificationsStore((s) => s.addFromSse)
  const loadNotifications = useNotificationsStore((s) => s.load)
  const loadUnreadCount = useNotificationsStore((s) => s.loadUnreadCount)
  const reloadCalendarOccurrences = useCalendarStore((s) => s.loadOccurrences)

  useEffect(() => {
    if (!user) return

    const es = new EventSource('/api/sse', { withCredentials: true })

    function onListEvent(e: MessageEvent<string>) {
      try {
        const data = JSON.parse(e.data) as SseEvent
        void handleListEvent(data)
        handleDashboardContentEvent(data)
      } catch {
        // malformed event — ignore
      }
    }

    function onCalendarEvent(e: MessageEvent<string>) {
      try {
        const data = JSON.parse(e.data) as SseEvent
        handleDashboardContentEvent(data)
      } catch {
        // malformed event — ignore
      } finally {
        const { windowStart, windowEnd, dashboardId } = useCalendarStore.getState()
        if (windowStart && windowEnd) {
          void reloadCalendarOccurrences(windowStart, windowEnd, dashboardId, { background: true })
        }
      }
    }

    function onNotification(e: MessageEvent<string>) {
      try {
        const notif = JSON.parse(e.data) as Notification
        addNotification(notif)
      } catch {
        void loadUnreadCount()
      }
    }

    function onDashboardEvent(e: MessageEvent<string>) {
      try {
        const data = JSON.parse(e.data) as SseEvent
        void handleDashboardEvent(data)
      } catch {
        // malformed event — ignore
      }
    }

    function onResync() {
      const resyncEvent = { event_type: 'resync', payload: {} } as SseEvent
      void handleListEvent(resyncEvent)
      void handleDashboardEvent(resyncEvent)
      handleDashboardContentEvent(resyncEvent)
      void loadUnreadCount()
      const { panelOpen } = useNotificationsStore.getState()
      if (panelOpen || window.location.pathname === '/notifications') {
        void loadNotifications()
      }
      const { windowStart, windowEnd, dashboardId } = useCalendarStore.getState()
      if (windowStart && windowEnd) {
        void reloadCalendarOccurrences(windowStart, windowEnd, dashboardId, { background: true })
      }
      window.dispatchEvent(new Event(APP_RESYNC_EVENT))
    }

    for (const type of LIST_EVENT_TYPES) {
      es.addEventListener(type, onListEvent)
    }
    for (const type of CALENDAR_EVENT_TYPES) {
      es.addEventListener(type, onCalendarEvent)
    }
    for (const type of DASHBOARD_EVENT_TYPES) {
      es.addEventListener(type, onDashboardEvent)
    }
    es.addEventListener('notification.created', onNotification)
    es.addEventListener('resync', onResync)

    return () => {
      es.close()
    }
  }, [
    user,
    handleListEvent,
    handleDashboardEvent,
    handleDashboardContentEvent,
    addNotification,
    loadNotifications,
    loadUnreadCount,
    reloadCalendarOccurrences,
  ])
}
