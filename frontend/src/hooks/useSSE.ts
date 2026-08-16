import { useEffect, useRef, useState } from 'react'
import type { ZodType, z } from 'zod'
import { apiFetch } from '../api/client'
import {
  ActivitySseEvent,
  ConnectedSseEvent,
  type EventType,
  NotificationSseEvent,
  ResyncSseEvent,
} from '../api/generated/contract'
import { handleAgendaResourceEvent } from '../resources/agendaData'
import { handleCalendarResourceEvent } from '../resources/calendarData'
import { handleListResourceEvent } from '../resources/listData'
import { handleMembersResourceEvent } from '../resources/membersData'
import { useAuthStore } from '../stores/auth'
import { useConnectionStore } from '../stores/connection'
import { useDashboardStore } from '../stores/dashboard'
import { useNotificationsStore } from '../stores/notifications'
import { isOwnFrame } from '../utils/shared/clientInstance'

/**
 * A server activity frame, straight from the contract.
 *
 * `payload` is `extra="allow"` backend-side — its shape varies per event type and only the
 * cross-cutting keys are modelled — and the generated schema keeps unknown keys, so nothing is
 * re-opened here. Re-adding a local widening would be a no-op.
 */
export type SseEvent = z.infer<typeof ActivitySseEvent>

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

/** Which resource handlers a changed entity type invalidates. */
const RESYNC_TARGETS: Record<string, readonly EventRoute[]> = {
  list: ['list'],
  list_item: ['list'],
  calendar_event: ['calendar'],
  dashboard: ['dashboard'],
}

/**
 * Resolve a scoped resync to the handlers it has to reach.
 *
 * Null for absent scopes *and* for an entity type this build doesn't know: a server that learned
 * to log something new must widen the refetch, not silently skip it.
 */
function resyncRoutes(scopes: string[] | null | undefined): Set<EventRoute> | null {
  if (!scopes) return null
  const routes = new Set<EventRoute>()
  for (const scope of scopes) {
    const targets = RESYNC_TARGETS[scope]
    if (!targets) return null
    for (const target of targets) routes.add(target)
  }
  return routes
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
  // Mutation frames are also feed entries — the store decides which, since only it knows the
  // filter. Without this the cached feed would refresh only on a resync and stop at page load.
  const addActivity = useNotificationsStore((s) => s.addActivityFromSse)
  const loadNotifications = useNotificationsStore((s) => s.load)
  const loadUnreadCount = useNotificationsStore((s) => s.loadUnreadCount)
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const needsResyncRef = useRef(false)
  // Highest activity id this tab has been sent. Handed back on reconnect so the server can say
  // whether anything happened meanwhile — a resync costs a refetch of every cache the tab holds.
  const watermarkRef = useRef<number | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce is bumped to force teardown/recreate of the EventSource; it's never read in the effect body.
  useEffect(() => {
    // Read rather than subscribed: this effect must not re-run when the status it sets changes.
    const { setConnectionStatus } = useConnectionStore.getState()

    if (!userId) {
      // Signed out — the stream is absent by design, which is not the same as degraded.
      setConnectionStatus('connecting')
      return
    }

    let cancelled = false
    // Only a reconnect can have missed anything, and only a known mark lets the server rule it
    // out; without both, the resync decision stays here and stays pessimistic.
    const serverDecidesResync = needsResyncRef.current && watermarkRef.current !== null
    const url = serverDecidesResync ? `/api/sse?last_event_id=${watermarkRef.current}` : '/api/sse'
    const es = new EventSource(url, { withCredentials: true })

    es.onerror = () => {
      // Set before the CLOSED check on purpose: a drop EventSource retries for us is still a
      // stream that is not delivering, and a silent outage is the state this exists to show.
      setConnectionStatus('reconnecting')

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

        // Flags the next connect as a reconnect: it either offers its mark and lets the server
        // rule a gap out, or has none and resyncs regardless. Events missed here are lost for good.
        needsResyncRef.current = true
        setReconnectNonce((n) => n + 1)
      }, reconnectDelayMs(attempt))
    }

    function onConnected(e: MessageEvent<string>) {
      reconnectAttemptsRef.current = 0
      setConnectionStatus('connected')
      const frame = parseFrame(e.data, ConnectedSseEvent)
      const head = frame?.last_event_id
      if (typeof head === 'number') watermarkRef.current = head
      if (!needsResyncRef.current) return
      needsResyncRef.current = false
      // When the server was given a mark it answers with a resync frame or with nothing, and
      // its silence is the answer. Resyncing here too would refetch everything regardless.
      if (!serverDecidesResync) onResync()
    }
    es.addEventListener('connected', onConnected)

    // Every activity frame moves the mark, whichever handler it is bound for, so the parse and
    // the bookkeeping stay together rather than being repeated per route.
    function readActivityFrame(e: MessageEvent<string>): SseEvent | null {
      const data = parseFrame(e.data, ActivitySseEvent)
      if (data && data.event_id > (watermarkRef.current ?? 0)) {
        watermarkRef.current = data.event_id
      }
      return data
    }

    function onListEvent(e: MessageEvent<string>) {
      const data = readActivityFrame(e)
      if (!data) return
      // Decided once and passed down so every handler acts on the same verdict.
      const isOwnEcho = isOwnFrame(data, userId)
      // Order is convention, not correctness — no handler reads another's writes.
      addActivity(data, userId)
      handleListResourceEvent(data, { isOwnEcho })
      handleAgendaResourceEvent(data, { isOwnEcho })
      // Not echo-gated: it only patches in memory (removing a deleted list's widget) and never
      // fetches, so running it for our own events is both harmless and necessary.
      handleDashboardContentEvent(data)
    }

    function onCalendarEvent(e: MessageEvent<string>) {
      const data = readActivityFrame(e)
      if (!data) return
      const isOwnEcho = isOwnFrame(data, userId)
      addActivity(data, userId)
      handleCalendarResourceEvent(data, { isOwnEcho })
      handleAgendaResourceEvent(data, { isOwnEcho })
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
      const data = readActivityFrame(e)
      if (!data) return
      addActivity(data, userId)
      handleMembersResourceEvent(data)
      void handleDashboardEvent(data)
    }

    function onResync(e?: MessageEvent<string>) {
      const frame = e ? parseFrame(e.data, ResyncSseEvent) : null
      // The ordered refetch covers everything up to the head the frame names, so the mark moves
      // with it — otherwise the next reconnect re-orders a resync this refetch already answered.
      const head = frame?.last_event_id
      if (typeof head === 'number' && head > (watermarkRef.current ?? 0)) {
        watermarkRef.current = head
      }
      // Agenda merges list reminders with calendar occurrences, so either scope reaches it.
      const routes = e ? resyncRoutes(frame?.scopes) : null
      const wants = (route: EventRoute) => routes === null || routes.has(route)

      if (wants('list')) handleListResourceEvent(RESYNC_SIGNAL)
      if (wants('calendar')) handleCalendarResourceEvent(RESYNC_SIGNAL)
      if (wants('list') || wants('calendar')) handleAgendaResourceEvent(RESYNC_SIGNAL)
      if (wants('dashboard')) {
        handleMembersResourceEvent(RESYNC_SIGNAL)
        void handleDashboardEvent(RESYNC_SIGNAL)
      }
      // Unconditional: notifications are not activity events, so no scope can rule them out.
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

    // A backgrounded tab — a phone locking, mostly — can have its stream torn down without
    // `error` ever firing, so neither the browser's retry nor the backoff below ever starts and
    // the tab returns looking live. `readyState` is the only signal: SSE pings are comment lines
    // the spec never surfaces to JavaScript, and a quiet household delivers nothing for hours.
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (es.readyState !== EventSource.CLOSED) return
      // A reconnect already scheduled by `onerror` is on its way; two would open two streams.
      if (reconnectTimerRef.current !== null) return
      needsResyncRef.current = true
      setReconnectNonce((n) => n + 1)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
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
