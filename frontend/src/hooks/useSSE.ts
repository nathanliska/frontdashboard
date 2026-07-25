import { useEffect, useRef, useState } from 'react'
import { type ZodType, z } from 'zod'
import { tryRefresh } from '../api/client'
import {
  ActivitySseEvent,
  ActivitySsePayload,
  type EventType,
  NotificationSseEvent,
} from '../api/generated/contract'
import { handleAgendaResourceEvent } from '../resources/agendaData'
import { handleCalendarResourceEvent } from '../resources/calendarData'
import { handleListResourceEvent } from '../resources/listData'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'
import { useNotificationsStore } from '../stores/notifications'

/**
 * A server activity frame. Generated from the backend's ActivitySseEvent contract, with one
 * local widening: that model is `extra="allow"` on `payload` (payload shape varies per event
 * type and only the cross-cutting keys are modelled), which the generator can't express — so
 * unknown payload keys are kept here instead of being silently stripped by validation.
 */
export const SseEventSchema = ActivitySseEvent.extend({
  payload: ActivitySsePayload.and(z.record(z.unknown())),
})

export type SseEvent = z.infer<typeof SseEventSchema>

/**
 * Not a server frame: the local "you may have missed events" signal, fanned out to the same
 * resource handlers so a gap in the stream converges through one code path. It is a distinct
 * member of the union rather than a fake SseEvent, so handlers must deal with it before they
 * can touch `payload`/`entity_id` — TypeScript narrows the rest away on the `resync` check.
 */
export interface ResyncSignal {
  event_type: 'resync'
}

export type ResourceEvent = SseEvent | ResyncSignal

export const RESYNC_SIGNAL: ResyncSignal = { event_type: 'resync' }

export const APP_RESYNC_EVENT = 'frontdashboard:resync'

// Reconnect backoff: 1s, 2s, 4s … capped at 30s, retried indefinitely. No jitter — a
// household-sized user base cannot thunder, and every tab backs off independently anyway.
const SSE_RECONNECT_BASE_MS = 1000
export const SSE_RECONNECT_MAX_MS = 30_000

type EventRoute = 'list' | 'calendar' | 'dashboard'

/**
 * Which handler each server event type is delivered to. Typed as a total `Record<EventType, …>`
 * over the generated enum on purpose: an event the backend can emit but nothing listens for
 * never reaches a cache and the UI silently goes stale (frontend/CLAUDE.md), so a new backend
 * EventType is a compile error here rather than a missing update at runtime.
 */
const EVENT_ROUTES: Record<EventType, EventRoute> = {
  'list.created': 'list',
  'list.updated': 'list',
  'list.archived': 'list',
  'list.deleted': 'list',
  'list.reordered': 'list',
  'list.item.created': 'list',
  'list.item.updated': 'list',
  'list.item.checked': 'list',
  'list.item.deleted': 'list',
  'list.item.reordered': 'list',
  'calendar.event.created': 'calendar',
  'calendar.event.updated': 'calendar',
  'calendar.event.deleted': 'calendar',
  'calendar.event.occurrence.updated': 'calendar',
  'calendar.event.occurrence.cancelled': 'calendar',
  'dashboard.created': 'dashboard',
  'dashboard.updated': 'dashboard',
  'dashboard.deleted': 'dashboard',
  'dashboard.share_added': 'dashboard',
  'dashboard.share_updated': 'dashboard',
  'dashboard.share_removed': 'dashboard',
}

/**
 * Parse and validate one SSE frame against its generated schema. A frame that is malformed or
 * off-contract is dropped (and logged) rather than flowing into the caches as a wrong shape.
 */
function parseFrame<T>(raw: string, schema: ZodType<T>): T | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    console.error('Malformed SSE frame', result.error.issues)
    return null
  }
  return result.data
}

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
        void tryRefresh().then((outcome) => {
          // The effect was torn down (logout, unmount) while the refresh was in flight.
          if (cancelled) return
          if (outcome === 'unauthorized') {
            window.location.replace('/login')
            return
          }
          // 'rate-limited' falls through to reconnect just like 'refreshed': the token
          // is still stale, so the new EventSource will be rejected and re-enter this
          // widening backoff — which self-throttles our refreshes — rather than logging
          // the user out over a transient 429.
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
      const data = parseFrame(e.data, SseEventSchema)
      if (!data) return
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
    }

    function onCalendarEvent(e: MessageEvent<string>) {
      const data = parseFrame(e.data, SseEventSchema)
      if (!data) return
      handleCalendarResourceEvent(data)
      handleAgendaResourceEvent(data)
    }

    function onNotification(e: MessageEvent<string>) {
      const notif = parseFrame(e.data, NotificationSseEvent)
      if (!notif) {
        // Unusable frame — fall back to the authoritative count so the badge stays honest.
        void loadUnreadCount()
        return
      }
      addNotification(notif)
    }

    function onDashboardEvent(e: MessageEvent<string>) {
      const data = parseFrame(e.data, SseEventSchema)
      if (!data) return
      void handleDashboardEvent(data)
    }

    function onResync() {
      handleListResourceEvent(RESYNC_SIGNAL)
      handleCalendarResourceEvent(RESYNC_SIGNAL)
      handleAgendaResourceEvent(RESYNC_SIGNAL)
      void handleDashboardEvent(RESYNC_SIGNAL)
      void loadUnreadCount()
      const { panelOpen } = useNotificationsStore.getState()
      if (panelOpen || window.location.pathname === '/notifications') {
        void loadNotifications()
      }
      window.dispatchEvent(new Event(APP_RESYNC_EVENT))
    }

    const handlersByRoute: Record<EventRoute, (e: MessageEvent<string>) => void> = {
      list: onListEvent,
      calendar: onCalendarEvent,
      dashboard: onDashboardEvent,
    }
    for (const [eventType, route] of Object.entries(EVENT_ROUTES)) {
      es.addEventListener(eventType, handlersByRoute[route])
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
