import { useEffect, useRef, useState } from 'react'
import { tryRefresh } from '../api/client'
import type { Notification } from '../api/notifications'
import { handleAgendaResourceEvent } from '../resources/agendaData'
import { handleCalendarResourceEvent } from '../resources/calendarData'
import { handleListResourceEvent } from '../resources/listData'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'
import { useNotificationsStore } from '../stores/notifications'

export interface SseEvent {
  event_id: number
  event_type: string
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
  'list.reordered',
  'list.item.created',
  'list.item.updated',
  'list.item.checked',
  'list.item.deleted',
  'list.item.reordered',
] as const

const CALENDAR_EVENT_TYPES = [
  'calendar.event.created',
  'calendar.event.updated',
  'calendar.event.deleted',
  'calendar.event.occurrence.updated',
  'calendar.event.occurrence.cancelled',
] as const

// Reconnect backoff: 1s, 2s, 4s … capped at 30s, retried indefinitely. No jitter — a
// household-sized user base cannot thunder, and every tab backs off independently anyway.
const SSE_RECONNECT_BASE_MS = 1000
export const SSE_RECONNECT_MAX_MS = 30_000

const DASHBOARD_EVENT_TYPES = [
  'dashboard.created',
  'dashboard.updated',
  'dashboard.deleted',
  'dashboard.share_added',
  'dashboard.share_updated',
  'dashboard.share_removed',
] as const

/**
 * Opens a single SSE connection for the authenticated user and routes
 * incoming events to the dashboard store plus the shared list/calendar
 * resource caches.
 *
 * Mount once inside the authenticated shell — closed automatically on logout.
 */
export function useSSE(): void {
  const user = useAuthStore((s) => s.user)
  const handleDashboardEvent = useDashboardStore((s) => s.handleDashboardEvent)
  const handleDashboardContentEvent = useDashboardStore((s) => s.handleContentEvent)
  const addNotification = useNotificationsStore((s) => s.addFromSse)
  const loadNotifications = useNotificationsStore((s) => s.load)
  const loadUnreadCount = useNotificationsStore((s) => s.loadUnreadCount)
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const needsResyncRef = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce is bumped after an auth-refresh succeeds purely to force teardown/recreate of the EventSource; it's never read in the effect body.
  useEffect(() => {
    if (!user) return

    let cancelled = false
    const es = new EventSource('/api/sse', { withCredentials: true })

    es.onerror = () => {
      // EventSource retries transient network drops itself (readyState CONNECTING) — that
      // covers a dropped link or a server that is down, which fail below HTTP. It does NOT
      // retry after an HTTP error status: the spec fails the connection and sets CLOSED. So
      // CLOSED means the server actively rejected us (expired cookie, or a 4xx/5xx bug), and
      // it is our only signal — the error event carries no status code.
      if (es.readyState !== EventSource.CLOSED) return
      if (reconnectTimerRef.current !== null) return

      // Back off rather than capping attempts. A cap would leave the app looking live while
      // receiving nothing, recoverable only by a reload; retrying forever on a widening delay
      // costs one request per 30s at worst and self-heals whenever the server does.
      const delay = Math.min(
        SSE_RECONNECT_BASE_MS * 2 ** reconnectAttemptsRef.current,
        SSE_RECONNECT_MAX_MS,
      )
      reconnectAttemptsRef.current += 1

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        void tryRefresh().then((ok) => {
          // The effect was torn down (logout, unmount) while the refresh was in flight.
          if (cancelled) return
          if (!ok) {
            window.location.replace('/login')
            return
          }
          // A fresh EventSource has an empty last-event-id, so it sends no Last-Event-ID header
          // and the server will NOT send a resync frame (see _should_resync_on_connect). Unlike
          // the browser's own auto-retry, this path must therefore ask for the resync itself, or
          // events broadcast while we were disconnected are lost from the caches for good.
          needsResyncRef.current = true
          setReconnectNonce((n) => n + 1)
        })
      }, delay)
    }

    function onConnected() {
      reconnectAttemptsRef.current = 0
      if (needsResyncRef.current) {
        needsResyncRef.current = false
        onResync()
      }
    }
    es.addEventListener('connected', onConnected)

    function onListEvent(e: MessageEvent<string>) {
      try {
        const data = JSON.parse(e.data) as SseEvent
        // Order is load-bearing, not convention. handleAgendaResourceEvent invalidates the
        // agenda reminders, and (if an agenda is mounted — invalidateWhere skips fetching for
        // unobserved scopes) that fetcher, loadDashboardListDetails, reads the list SUMMARIES
        // cache synchronously, before its first await. So summaries must already carry this
        // event's changes. Run the agenda first and a `list.deleted` leaves the deleted list in
        // the summaries it reads, then fetches that dead id -> 404 -> the agenda widget errors.
        // (Only summaries is read synchronously; the per-list detail fetches sit after an await
        // and would see patched data either way.)
        handleListResourceEvent(data)
        handleAgendaResourceEvent(data)
        handleDashboardContentEvent(data)
      } catch {
        // malformed event — ignore
      }
    }

    function onCalendarEvent(e: MessageEvent<string>) {
      try {
        const data = JSON.parse(e.data) as SseEvent
        handleCalendarResourceEvent(data)
        handleAgendaResourceEvent(data)
      } catch {
        // malformed event — ignore
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
      handleListResourceEvent(resyncEvent)
      handleCalendarResourceEvent(resyncEvent)
      handleAgendaResourceEvent(resyncEvent)
      void handleDashboardEvent(resyncEvent)
      void loadUnreadCount()
      const { panelOpen } = useNotificationsStore.getState()
      if (panelOpen || window.location.pathname === '/notifications') {
        void loadNotifications()
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
      cancelled = true
      // A pending reconnect is always obsolete here: either we are unmounting/logging out, or
      // the effect is re-running and about to open a fresh stream itself.
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      es.close()
    }
  }, [
    user,
    handleDashboardEvent,
    handleDashboardContentEvent,
    addNotification,
    loadNotifications,
    loadUnreadCount,
    reconnectNonce,
  ])
}
