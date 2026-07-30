import { useEffect, useRef, useState } from 'react'
import { type ZodType, z } from 'zod'
import { apiFetch } from '../api/client'
import {
  ActivitySseEvent,
  ActivitySsePayload,
  type EventType,
  NotificationSseEvent,
} from '../api/generated/contract'
import { handleAgendaResourceEvent } from '../resources/agendaData'
import { handleCalendarResourceEvent } from '../resources/calendarData'
import { consumePendingListMutationEcho, handleListResourceEvent } from '../resources/listData'
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

// Reconnect backoff: 1s, 2s, 4s … capped at 30s, retried indefinitely.
const SSE_RECONNECT_BASE_MS = 1000
export const SSE_RECONNECT_MAX_MS = 30_000

// How often, in reconnect attempts, to ask whether the session is still alive. Every attempt
// would hammer a backend that is merely down; never leaves a logged-out tab retrying forever.
export const SSE_AUTH_PROBE_EVERY = 4

// Full jitter: every stream drops on the same backend restart, so without it every tab retries
// on the same schedule against the one worker still coming up.
function reconnectDelayMs(attempt: number): number {
  const ceiling = Math.min(SSE_RECONNECT_BASE_MS * 2 ** attempt, SSE_RECONNECT_MAX_MS)
  return Math.random() * ceiling
}

type EventRoute = 'list' | 'calendar' | 'dashboard'

/**
 * Which handler each server event type is delivered to. Typed as a total `Record<EventType, …>`
 * over the generated enum on purpose: an event the backend can emit but nothing listens for
 * never reaches a cache and the UI silently goes stale, so a new backend
 * EventType is a compile error here rather than a missing update at runtime.
 */
const EVENT_ROUTES: Record<EventType, EventRoute> = {
  'list.created': 'list',
  'list.updated': 'list',
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
  // Key on identity, not the user object: preferences/profile PATCHes replace the object, and
  // depending on it here tore the EventSource down and reconnected after every such save.
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const handleDashboardEvent = useDashboardStore((s) => s.handleDashboardEvent)
  const handleDashboardContentEvent = useDashboardStore((s) => s.handleContentEvent)
  const addNotification = useNotificationsStore((s) => s.addFromSse)
  // Every mutation frame is also an activity-feed entry. Without this the cached feed would refresh
  // only on a resync, so the tab would show a timeline that stopped at page load.
  const addActivity = useNotificationsStore((s) => s.addActivityFromSse)
  const loadNotifications = useNotificationsStore((s) => s.load)
  const loadUnreadCount = useNotificationsStore((s) => s.loadUnreadCount)
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const needsResyncRef = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce is bumped to force teardown/recreate of the EventSource; it's never read in the effect body.
  useEffect(() => {
    if (!userId) return

    let cancelled = false
    const es = new EventSource('/api/sse', { withCredentials: true })

    es.onerror = () => {
      // EventSource retries below-HTTP drops itself but not an error status, where the spec
      // sets CLOSED. So CLOSED means the server rejected us — and the event carries no status.
      if (es.readyState !== EventSource.CLOSED) return
      if (reconnectTimerRef.current !== null) return

      // Back off rather than cap: a cap leaves the app looking live while receiving nothing,
      // recoverable only by a reload. One request per 30s at worst, and it self-heals.
      const attempt = reconnectAttemptsRef.current
      reconnectAttemptsRef.current += 1

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        if (cancelled) return

        // Nothing else reveals a dead session, so a logged-out tab would retry forever looking
        // connected. `apiFetch` handles the 401; the catch is for its network-failure throw.
        if (attempt > 0 && attempt % SSE_AUTH_PROBE_EVERY === 0) {
          void apiFetch('/api/auth/me').catch(() => {})
        }

        // A fresh EventSource sends no Last-Event-ID, so the server sends no resync frame.
        // This path must ask for one, or events missed while disconnected are lost for good.
        needsResyncRef.current = true
        setReconnectNonce((n) => n + 1)
      }, reconnectDelayMs(attempt))
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
      // Asked once and passed down: the check consumes the pending mutation id, so whichever
      // handler called it first would be the only one told the truth.
      const isOwnEcho = consumePendingListMutationEcho(data)
      // Order is convention, not correctness — no handler reads another's writes.
      addActivity(data)
      handleListResourceEvent(data, { isOwnEcho })
      handleAgendaResourceEvent(data, { isOwnEcho })
      // Not echo-gated: it only patches in memory (removing a deleted list's widget) and never
      // fetches, so running it for our own events is both harmless and necessary.
      handleDashboardContentEvent(data)
    }

    function onCalendarEvent(e: MessageEvent<string>) {
      const data = parseFrame(e.data, SseEventSchema)
      if (!data) return
      addActivity(data)
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
      addActivity(data)
      void handleDashboardEvent(data)
    }

    function onResync() {
      handleListResourceEvent(RESYNC_SIGNAL)
      handleCalendarResourceEvent(RESYNC_SIGNAL)
      handleAgendaResourceEvent(RESYNC_SIGNAL)
      void handleDashboardEvent(RESYNC_SIGNAL)
      void loadUnreadCount()
      const { panelOpen, activityLoaded, loadActivity } = useNotificationsStore.getState()
      if (panelOpen || window.location.pathname === '/notifications') {
        void loadNotifications()
      }
      // Frames may have been dropped, so the cached feed can no longer be trusted — but only
      // re-read one that was actually being shown.
      if (activityLoaded) void loadActivity({ force: true })
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
    userId,
    handleDashboardEvent,
    handleDashboardContentEvent,
    addNotification,
    loadNotifications,
    loadUnreadCount,
    reconnectNonce,
  ])
}
